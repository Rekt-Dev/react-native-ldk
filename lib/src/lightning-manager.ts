import ldk from './ldk';
import { err, ok, Result } from './utils/result';
import {
	DefaultLdkDataShape,
	DefaultTransactionDataShape,
	EEventTypes,
	ELdkData,
	ELdkFiles,
	ELdkLogLevels,
	ENetworks,
	TAccount,
	TAccountBackup,
	TAddPeerReq,
	TBroadcastTransaction,
	TBroadcastTransactionEvent,
	TChannelManagerChannelClosed,
	TChannelManagerDiscardFunding,
	TChannelManagerFundingGenerationReady,
	TChannelManagerOpenChannelRequest,
	TChannelManagerPayment,
	TChannelManagerPaymentFailed,
	TChannelManagerPaymentPathFailed,
	TChannelManagerPaymentPathSuccessful,
	TChannelManagerPaymentSent,
	TChannelManagerPendingHtlcsForwardable,
	TChannelManagerSpendableOutputs,
	TGetAddress,
	TGetScriptPubKeyHistory,
	TGetScriptPubKeyHistoryResponse,
	TGetBestBlock,
	TGetTransactionData,
	THeader,
	TLdkPeers,
	TLdkStart,
	TPeer,
	TRegisterOutputEvent,
	TRegisterTxEvent,
	TTransactionData,
	TLdkConfirmedOutputs,
	TLdkConfirmedTransactions,
	TLdkBroadcastedTransactions,
	TEmergencyForceCloseChannel,
} from './utils/types';
import { appendPath, parseData, startParamCheck } from './utils/helpers';
import * as bitcoin from 'bitcoinjs-lib';
import { networks } from 'bitcoinjs-lib';

//TODO startup steps
// Step 0: Listen for events ✅
// Step 1: Initialize the FeeEstimator ✅
// Step 2: Initialize the Logger ✅
// Step 3: Initialize the BroadcasterInterface ✅
// Step 4: Initialize Persist ✅
// Step 5: Initialize the ChainMonitor ✅
// Step 6: Initialize the KeysManager ✅
// Step 7: Read ChannelMonitor state from disk ✅
// Step 8: Initialize the ChannelManager ✅
// Step 9: Sync ChannelMonitors and ChannelManager to chain tip ✅
// Step 10: Give ChannelMonitors to ChainMonitor ✅
// Step 11: Optional: Initialize the NetGraphMsgHandler [Not required for a non routing node]
// Step 12: Initialize the PeerManager ✅
// Step 13: Initialize networking ✅
// Step 14: Connect and Disconnect Blocks ✅
// Step 15: Handle LDK Events ✅
// Step 16: Initialize routing ProbabilisticScorer [Not sure if required]
// Step 17: Create InvoicePayer ✅
// Step 18: Persist ChannelManager and NetworkGraph ✅
// Step 19: Background Processing

class LightningManager {
	currentBlock: THeader = {
		hex: '',
		hash: '',
		height: 0,
	};
	watchTxs: TRegisterTxEvent[] = [];
	watchOutputs: TRegisterOutputEvent[] = [];
	getBestBlock: TGetBestBlock = async (): Promise<THeader> => ({
		hex: '',
		hash: '',
		height: 0,
	});
	account: TAccount = {
		name: '',
		seed: '',
	};
	backupSubscriptions: {
		[id: string]: (backup: Result<TAccountBackup>) => void;
	} = {};
	backupSubscriptionsId = 0;
	backupSubscriptionsDebounceTimer: NodeJS.Timeout | undefined = undefined;
	getTransactionData: TGetTransactionData =
		async (): Promise<TTransactionData> => DefaultTransactionDataShape;
	network: ENetworks = ENetworks.regtest;
	baseStoragePath = '';
	logFilePath = '';
	getAddress: TGetAddress = async (): Promise<string> => '';
	getScriptPubKeyHistory: TGetScriptPubKeyHistory = async (): Promise<
		TGetScriptPubKeyHistoryResponse[]
	> => [];
	broadcastTransaction: TBroadcastTransaction = async (): Promise<any> => {};
	feeRate: number = 1000; // feerate_sat_per_1000_weight

	constructor() {
		// Step 0: Subscribe to all events
		ldk.onEvent(EEventTypes.native_log, (line) =>
			console.log(`NATIVE LOG: ${line}`),
		);
		ldk.onEvent(EEventTypes.ldk_log, (line) => console.log(`LDK: ${line}`));
		ldk.onEvent(EEventTypes.register_tx, this.onRegisterTx.bind(this));
		ldk.onEvent(EEventTypes.register_output, this.onRegisterOutput.bind(this));
		ldk.onEvent(
			EEventTypes.broadcast_transaction,
			this.onBroadcastTransaction.bind(this),
		);

		ldk.onEvent(EEventTypes.backup, this.onLdkBackupEvent.bind(this));

		//Channel manager handle events:
		ldk.onEvent(
			EEventTypes.channel_manager_funding_generation_ready,
			this.onChannelManagerFundingGenerationReady.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_payment_received,
			this.onChannelManagerPaymentReceived.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_payment_sent,
			this.onChannelManagerPaymentSent.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_open_channel_request,
			this.onChannelManagerOpenChannelRequest.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_payment_path_successful,
			this.onChannelManagerPaymentPathSuccessful.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_payment_path_failed,
			this.onChannelManagerPaymentPathFailed.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_payment_failed,
			this.onChannelManagerPaymentFailed.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_pending_htlcs_forwardable,
			this.onChannelManagerPendingHtlcsForwardable.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_spendable_outputs,
			this.onChannelManagerSpendableOutputs.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_channel_closed,
			this.onChannelManagerChannelClosed.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_discard_funding,
			this.onChannelManagerDiscardFunding.bind(this),
		);
		ldk.onEvent(
			EEventTypes.channel_manager_payment_claimed,
			this.onChannelManagerPaymentClaimed.bind(this),
		);
		ldk.onEvent(
			EEventTypes.emergency_force_close_channel,
			this.onEmergencyForceCloseChannel.bind(this),
		);
	}

	/**
	 * Sets storage path on disk where all wallet accounts will be
	 * stored in subdirectories
	 * @param path
	 * @returns {Promise<Ok<string>>}
	 */
	async setBaseStoragePath(path: string): Promise<Result<string>> {
		const storagePath = appendPath(path, ''); //Adds slash if missing
		//Storage path will be validated and created when calling ldk.setAccountStoragePath
		this.baseStoragePath = storagePath;
		return ok('Storage set');
	}

	/**
	 * Spins up and syncs all processes
	 * @param {string} seed
	 * @param {string} genesisHash
	 * @param {TGetBestBlock} getBestBlock
	 * @param {TGetTransactionData} getTransactionData
	 * @param {TGetAddress} getAddress
	 * @param {ENetworks} network
	 * @returns {Promise<Result<string>>}
	 */
	async start({
		account,
		genesisHash,
		getBestBlock,
		getTransactionData,
		getAddress,
		getScriptPubKeyHistory,
		broadcastTransaction,
		network = ENetworks.regtest,
		feeRate = this.feeRate,
	}: TLdkStart): Promise<Result<string>> {
		if (!account) {
			return err(
				'No account provided. Please pass an account object containing the name & seed to the start method and try again.',
			);
		}
		if (!account?.name || !account?.seed) {
			return err(
				'No account name or seed provided. Please pass an account object containing the name & seed to the start method and try again.',
			);
		}
		if (!getBestBlock) {
			return err('getBestBlock method not specified in start method.');
		}
		if (!genesisHash) {
			return err(
				'No genesisHash provided. Please pass genesisHash to the start method and try again.',
			);
		}
		if (!getTransactionData) {
			return err('getTransactionData is not set in start method.');
		}

		// Ensure the start params function as expected.
		const paramCheckResponse = await startParamCheck({
			account,
			genesisHash,
			getBestBlock,
			getTransactionData,
			broadcastTransaction,
			getAddress,
			getScriptPubKeyHistory,
			network,
		});
		if (paramCheckResponse.isErr()) {
			return err(paramCheckResponse.error.message);
		}

		this.getBestBlock = getBestBlock;
		this.account = account;
		this.network = network;
		this.feeRate = feeRate;
		this.getAddress = getAddress;
		this.getScriptPubKeyHistory = getScriptPubKeyHistory;
		this.broadcastTransaction = broadcastTransaction;
		this.getTransactionData = getTransactionData;
		const bestBlock = await this.getBestBlock();
		this.currentBlock = bestBlock;
		this.watchTxs = [];
		this.watchOutputs = [];

		if (!this.baseStoragePath) {
			return err(
				'baseStoragePath required for wallet persistence. Call setBaseStoragePath(path) first.',
			);
		}

		//The path all wallet and network graph persistence will be saved to
		let accountStoragePath = appendPath(this.baseStoragePath, account.name);
		const storagePathRes = await ldk.setAccountStoragePath(accountStoragePath);
		if (storagePathRes.isErr()) {
			return storagePathRes;
		}

		this.logFilePath = `${accountStoragePath}/logs/${Date.now()}.log`;
		const logFilePathRes = await ldk.setLogFilePath(this.logFilePath);
		if (logFilePathRes.isErr()) {
			return logFilePathRes;
		}

		//Validate we didn't change the seed for this account if one exists
		const readSeed = await ldk.readFromFile({
			fileName: ELdkFiles.seed,
			format: 'hex',
		});
		if (readSeed.isErr()) {
			if (readSeed.code === 'file_does_not_exist') {
				//Have not yet saved the seed to disk
				const writeRes = await ldk.writeToFile({
					fileName: ELdkFiles.seed,
					content: account.seed,
					format: 'hex',
				});
				if (writeRes.isErr()) {
					return err(writeRes.error);
				}
			} else {
				return err(readSeed.error);
			}
		} else {
			//Cannot start an existing node with a different seed
			if (readSeed.value.content !== account.seed) {
				return err('Seed for current node cannot be changed.');
			}
		}

		// Step 1: Initialize the FeeEstimator
		// Lazy loaded in native code
		// https://docs.rs/lightning/latest/lightning/chain/chaininterface/trait.FeeEstimator.html

		// Set fee estimates
		const feeUpdateRes = await ldk.updateFees({
			highPriority: 12500,
			normal: 12500,
			background: 12500,
		});
		if (feeUpdateRes.isErr()) {
			return feeUpdateRes;
		}

		// Step 2: Initialize the Logger
		// Lazy loaded in native code
		// https://docs.rs/lightning/latest/lightning/util/logger/index.html

		//Switch on log levels we're interested in. All levels are false by default.
		await ldk.setLogLevel(ELdkLogLevels.info, true);
		await ldk.setLogLevel(ELdkLogLevels.warn, true);
		await ldk.setLogLevel(ELdkLogLevels.error, true);
		await ldk.setLogLevel(ELdkLogLevels.debug, true);

		//TODO might not always need this one as they make the logs a little noisy
		// await ldk.setLogLevel(ELdkLogLevels.trace, true);

		// Step 3: Initialize the BroadcasterInterface
		// Lazy loaded in native code
		// https://docs.rs/lightning/latest/lightning/chain/chaininterface/trait.BroadcasterInterface.html

		// Step 4: Initialize Persist
		// Lazy loaded in native code
		// https://docs.rs/lightning/latest/lightning/chain/chainmonitor/trait.Persist.html

		// Step 5: Initialize the ChainMonitor
		const chainMonitorRes = await ldk.initChainMonitor();
		if (chainMonitorRes.isErr()) {
			return chainMonitorRes;
		}

		// Step 6: Initialize the KeysManager
		const keysManager = await ldk.initKeysManager(this.account.seed);
		if (keysManager.isErr()) {
			return keysManager;
		}

		// Step 7: Read ChannelMonitors state from disk
		// Handled in initChannelManager below

		// Step 11: Optional: Initialize the NetGraphMsgHandler
		const networkGraphRes = await ldk.initNetworkGraph({
			genesisHash,
		});
		if (networkGraphRes.isErr()) {
			return networkGraphRes;
		}

		// Step 8: Initialize the UserConfig ChannelManager
		const confRes = await ldk.initConfig({
			acceptInboundChannels: true,
			manuallyAcceptInboundChannels: false,
			announcedChannels: false,
			minChannelHandshakeDepth: 1, //TODO Verify correct min
		});
		if (confRes.isErr()) {
			return confRes;
		}

		const channelManagerRes = await ldk.initChannelManager({
			network: this.network,
			bestBlock,
		});
		if (channelManagerRes.isErr()) {
			return channelManagerRes;
		}

		// Add Peers
		const peers = await this.getPeers();
		await Promise.all(
			peers.map((peer: TPeer) => {
				this.addPeer({ ...peer, timeout: 4000 });
			}),
		);

		// Step 9: Sync ChannelMonitors and ChannelManager to chain tip
		await this.syncLdk();

		// Step 10: Give ChannelMonitors to ChainMonitor

		// Step 12: Initialize the PeerManager
		// Done with initChannelManager
		// Step 13: Initialize networking
		// Done with initChannelManager

		return ok('Node running');
	}

	/**
	 * Fetches current best block and sends to LDK to update both channelManager and chainMonitor.
	 * Also watches transactions and outputs for confirmed and unconfirmed transactions and updates LDK.
	 * @returns {Promise<Result<string>>}
	 */
	async syncLdk(): Promise<Result<string>> {
		if (!this.getBestBlock) {
			return err('No getBestBlock method provided.');
		}
		const bestBlock = await this.getBestBlock();
		const header = bestBlock?.hex;
		const height = bestBlock?.height;

		//Don't update unnecessarily
		if (this.currentBlock.hash !== bestBlock?.hash) {
			const syncToTip = await ldk.syncToTip({
				header,
				height,
			});
			if (syncToTip.isErr()) {
				return syncToTip;
			}

			this.currentBlock = bestBlock;
		}

		const confirmedTxs = await this.getLdkConfirmedTxs();
		// Iterate over watch transactions and set whether they are confirmed or unconfirmed.
		await Promise.all(
			this.watchTxs.map(async ({ txid, script_pubkey }) => {
				if (confirmedTxs.includes(txid)) {
					return;
				}
				const response = await this.getTransactionData(txid);
				if (!response?.header || !response.transaction) {
					return err(
						'Unable to retrieve transaction data from the getTransactionData method.',
					);
				}
				if (response.height > 0) {
					await Promise.all(
						response.vout.map(async (o) => {
							if (o.hex === script_pubkey) {
								const pos = o.n;
								await ldk.setTxConfirmed({
									header: response.header,
									height: response.height,
									txData: [{ transaction: response.transaction, pos }],
								});
								await this.saveConfirmedTxs(txid);
								this.watchTxs = this.watchTxs.filter((tx) => tx.txid !== txid);
							}
						}),
					);
				}
			}),
		);

		const confirmedWatchOutputs = await this.getLdkConfirmedOutputs();
		await Promise.all(
			this.watchOutputs.map(async ({ index, script_pubkey }) => {
				if (confirmedWatchOutputs.includes(script_pubkey)) {
					return;
				}
				const transactions = await this.getScriptPubKeyHistory(script_pubkey);
				await Promise.all(
					transactions.map(async ({ txid }) => {
						const transactionData = await this.getTransactionData(txid);
						if (
							!transactionData?.height &&
							transactionData?.vout?.length < index + 1
						) {
							return;
						}

						const txs = await this.getScriptPubKeyHistory(
							transactionData?.vout[index].hex,
						);

						// We're looking for the second transaction from this address.
						if (txs.length <= 1) {
							return;
						}

						// We only need the second transaction.
						const tx = txs[1];
						const txData = await this.getTransactionData(tx.txid);
						if (!txData?.height) {
							return;
						}
						const pos = txData.vout[index].n;
						await ldk.setTxConfirmed({
							header: txData.header,
							height: txData.height,
							txData: [{ transaction: txData.transaction, pos }],
						});
						await this.saveConfirmedOutputs(script_pubkey);
						this.watchOutputs = this.watchOutputs.filter(
							(o) => o.script_pubkey !== script_pubkey,
						);
					}),
				);
			}),
		);

		return ok(`Synced to block ${height}`);
	}

	/**
	 * Passes a peer to LDK to add and saves it to storage if successful.
	 * @param {string} pubKey
	 * @param {string} address
	 * @param {number} port
	 * @param {number} timeout
	 * @returns {Promise<Result<string>>}
	 */
	addPeer = async ({
		pubKey,
		address,
		port,
		timeout,
	}: TAddPeerReq): Promise<Result<string>> => {
		const peer: TPeer = { pubKey, address, port };
		const addPeerResponse = await ldk.addPeer({
			...peer,
			timeout,
		});
		if (addPeerResponse.isErr()) {
			return err(addPeerResponse.error.message);
		}
		this.saveLdkPeerData(peer).then().catch(console.error);
		return ok(addPeerResponse.value);
	};

	/**
	 * Removes the specified peer from storage.
	 * @param {string} pubKey
	 * @param {string} address
	 * @param {number} port
	 * @returns {Promise<Result<TPeer[]>>}
	 */
	removePeer = async ({
		pubKey,
		address,
		port,
	}: TAddPeerReq): Promise<Result<TPeer[]>> => {
		const peers = await this.getPeers();
		const newPeers = peers.filter(
			(p) => p.pubKey !== pubKey && p.address !== address && p.port !== port,
		);

		const writeRes = await ldk.writeToFile({
			fileName: ELdkFiles.peers,
			content: JSON.stringify(newPeers),
		});

		if (writeRes.isErr()) {
			return err(writeRes.error);
		}

		return ok(newPeers);
	};

	/**
	 * Returns saved peers from storage for the current seed.
	 * @returns {Promise<TLdkPeers>}
	 */
	getPeers = async (): Promise<TLdkPeers> => {
		const res = await ldk.readFromFile({ fileName: ELdkFiles.peers });
		if (res.isOk()) {
			return parseData(res.value.content, DefaultLdkDataShape.peers);
		}

		return DefaultLdkDataShape.peers;
	};

	/**
	 * This method is used to import backups provided by react-native-ldk's backupAccount method.
	 * @param {TAccountBackup} accountData
	 * @param {string} storagePath Default LDK storage path on disk
	 * @param {boolean} [overwrite] Determines if this function should overwrite an existing account of the same name.
	 * @returns {Promise<Result<TAccount>>} TAccount is used to start the node using the newly imported and saved data.
	 */
	importAccount = async ({
		backup,
		overwrite = false,
	}: {
		backup: string | TAccountBackup;
		overwrite?: boolean;
	}): Promise<Result<TAccount>> => {
		if (!this.baseStoragePath) {
			return err(
				'baseStoragePath required for wallet persistence. Call setBaseStoragePath(path) first.',
			);
		}

		try {
			if (!backup) {
				return err('No backup was provided for import.');
			}
			let accountBackup: TAccountBackup;
			if (typeof backup === 'string') {
				try {
					accountBackup = JSON.parse(backup);
				} catch {
					return err('Invalid backup string.');
				}
			} else if (typeof backup === 'object') {
				// It's possible the dev passed the TAccountBackup object instead of the JSON string.
				accountBackup = backup;
			} else {
				return err('Invalid backup. Unable to import.');
			}
			if (!accountBackup?.account.name) {
				return err('No account name was provided in the accountBackup object.');
			}
			if (!accountBackup?.account.seed) {
				return err('No seed was provided in the accountBackup object.');
			}
			if (!accountBackup?.data) {
				return err('No data was provided in the accountBackup object.');
			}

			if (
				!(ELdkData.channel_manager in accountBackup.data) ||
				!(ELdkData.channel_monitors in accountBackup.data) ||
				!(ELdkData.peers in accountBackup.data) ||
				!(ELdkData.confirmed_outputs in accountBackup.data) ||
				!(ELdkData.confirmed_transactions in accountBackup.data) ||
				!(ELdkData.broadcasted_transactions in accountBackup.data) ||
				!(ELdkData.timestamp in accountBackup.data)
			) {
				return err(
					`Invalid account backup data. Please ensure the following keys exist in the accountBackup object: ${ELdkData.channel_manager}, ${ELdkData.channel_monitors}, ${ELdkData.peers}, ${ELdkData.confirmed_transactions}, , ${ELdkData.confirmed_outputs}`,
				);
			}

			const accountPath = appendPath(
				this.baseStoragePath,
				accountBackup.account.name,
			);

			// Ensure the user is not attempting to import an old/stale backup.
			let timestamp = 0;
			const channelManagerRes = await ldk.readFromFile({
				fileName: ELdkFiles.channel_manager,
				path: accountPath,
				format: 'hex',
			});
			if (
				channelManagerRes.isErr() &&
				channelManagerRes.code !== 'file_does_not_exist' // If the file doesn't exist assume there's no backup to be overwritten
			) {
				return err(channelManagerRes.error);
			}

			if (channelManagerRes.isOk()) {
				channelManagerRes.value;
			}

			if (!overwrite && accountBackup.data?.timestamp <= timestamp) {
				const msg =
					accountBackup.data?.timestamp < timestamp
						? 'This appears to be an old backup. The stored backup is more recent than the backup trying to be imported.'
						: 'No need to import. The backup timestamps match.';
				return err(msg);
			}

			//Save the provided backup data to files
			const saveChannelManagerRes = await ldk.writeToFile({
				fileName: ELdkFiles.channel_manager,
				path: accountPath,
				content: accountBackup.data.channel_manager,
				format: 'hex',
			});
			if (saveChannelManagerRes.isErr()) {
				return err(saveChannelManagerRes.error);
			}

			let channelIds = Object.keys(accountBackup.data.channel_monitors);
			for (let index = 0; index < channelIds.length; index++) {
				const channelId = channelIds[index];

				const saveChannelRes = await ldk.writeToFile({
					fileName: `${channelId}.bin`,
					path: appendPath(accountPath, ELdkFiles.channels),
					content: accountBackup.data.channel_monitors[channelId],
					format: 'hex',
				});
				if (saveChannelRes.isErr()) {
					return err(saveChannelRes.error);
				}
			}

			const savePeersRes = await ldk.writeToFile({
				fileName: ELdkFiles.peers,
				path: accountPath,
				content: JSON.stringify(accountBackup.data.peers),
			});
			if (savePeersRes.isErr()) {
				return err(savePeersRes.error);
			}

			const confirmedTxRes = await ldk.writeToFile({
				fileName: ELdkFiles.confirmed_transactions,
				path: accountPath,
				content: JSON.stringify(accountBackup.data.confirmed_transactions),
			});
			if (confirmedTxRes.isErr()) {
				return err(confirmedTxRes.error);
			}

			const confirmedOutRes = await ldk.writeToFile({
				fileName: ELdkFiles.confirmed_outputs,
				path: accountPath,
				content: JSON.stringify(accountBackup.data.confirmed_outputs),
			});
			if (confirmedOutRes.isErr()) {
				return err(confirmedOutRes.error);
			}

			const broadcastedTxRes = await ldk.writeToFile({
				fileName: ELdkFiles.broadcasted_transactions,
				path: accountPath,
				content: JSON.stringify(accountBackup.data.broadcasted_transactions),
			});
			if (broadcastedTxRes.isErr()) {
				return err(broadcastedTxRes.error);
			}

			//Return the saved account info.
			return ok(accountBackup.account);
		} catch (e) {
			return err(e);
		}
	};

	/**
	 * Used to back up the data that corresponds with the provided account.
	 * @param {TAccount} account
	 * @returns {TAccountBackup} This object can be stringified and used to import/restore this LDK account via importAccount.
	 */
	backupAccount = async ({
		account,
	}: {
		account: TAccount;
	}): Promise<Result<TAccountBackup>> => {
		if (!this.baseStoragePath) {
			return err(
				'baseStoragePath required for wallet persistence. Call setBaseStoragePath(path) first.',
			);
		}

		try {
			if (!account || !this?.account) {
				return err(
					'No account provided. Please pass an account object containing the name & seed to the start method and try again.',
				);
			}
			if (!account) {
				account = this.account;
			}
			if (!account?.name || !account?.seed) {
				return err(
					'No account name or seed provided. Please pass an account object containing the name & seed to the start method and try again.',
				);
			}

			const accountPath = appendPath(this.baseStoragePath, account.name);

			//Get serialised channel manager
			const channelManagerRes = await ldk.readFromFile({
				fileName: ELdkFiles.channel_manager,
				path: accountPath,
				format: 'hex',
			});
			if (channelManagerRes.isErr()) {
				return err(channelManagerRes.error);
			}

			//Get serialised channels
			const listChannelsRes = await ldk.listChannels();
			if (listChannelsRes.isErr()) {
				return err(listChannelsRes.error);
			}

			let channel_monitors: { [key: string]: string } = {};
			for (let index = 0; index < listChannelsRes.value.length; index++) {
				const { channel_id } = listChannelsRes.value[index];

				const serialisedChannelRes = await ldk.readFromFile({
					fileName: `${channel_id}.bin`,
					path: appendPath(accountPath, ELdkFiles.channels),
					format: 'hex',
				});
				if (serialisedChannelRes.isErr()) {
					return err(serialisedChannelRes.error);
				}

				channel_monitors[channel_id] = serialisedChannelRes.value.content;
			}

			const accountBackup: TAccountBackup = {
				account,
				data: {
					channel_manager: channelManagerRes.value.content,
					channel_monitors: channel_monitors,
					peers: await this.getPeers(),
					confirmed_transactions: await this.getLdkConfirmedTxs(),
					confirmed_outputs: await this.getLdkConfirmedOutputs(),
					broadcasted_transactions: await this.getLdkBroadcastedTxs(),
					timestamp: Date.now(),
				},
				package_version: require('../package.json').version,
			};
			return ok(accountBackup);
		} catch (e) {
			return err(e);
		}
	};

	/**
	 * Subscribe to back up events and receive full backups to callback passed
	 * @param callback
	 * @returns {string}
	 */
	subscribeToBackups(
		callback: (backup: Result<TAccountBackup>) => void,
	): string {
		this.backupSubscriptionsId++;
		const id = `${this.backupSubscriptionsId}`;
		this.backupSubscriptions[id] = callback;
		return id;
	}

	/**
	 * Unsubscribe from backup events
	 * @param id
	 */
	unsubscribeFromBackups(id: string): void {
		if (this.backupSubscriptions[id]) {
			delete this.backupSubscriptions[id];
		}
	}

	/**
	 * Handle native events triggering backups by debouncing and fetching data after
	 * a timeout to avoid too many backup events being triggered right after each other.
	 * @returns {Promise<void>}
	 */
	private async onLdkBackupEvent(): Promise<void> {
		if (this.backupSubscriptionsDebounceTimer) {
			clearTimeout(this.backupSubscriptionsDebounceTimer);
		}

		this.backupSubscriptionsDebounceTimer = setTimeout(async () => {
			const backupRes = await this.backupAccount({ account: this.account });

			//Process all subscriptions
			Object.keys(this.backupSubscriptions).forEach((id) => {
				const callback = this.backupSubscriptions[id];
				if (callback) {
					callback(backupRes);
				}
			});
		}, 250);
	}

	/**
	 * Returns change destination script for the provided address.
	 * @param {string} address
	 * @returns {string}
	 */
	private getChangeDestinationScript = (address = ''): string => {
		try {
			// @ts-ignore
			const network = networks[this.network];
			const script = bitcoin.address.toOutputScript(address, network);
			return script.toString('hex');
		} catch (e) {
			console.log(e);
			return '';
		}
	};

	/**
	 * Returns previously confirmed transactions from storage.
	 * @returns {Promise<TLdkConfirmedTransactions>}
	 */
	private getLdkConfirmedTxs = async (): Promise<TLdkConfirmedTransactions> => {
		const res = await ldk.readFromFile({
			fileName: ELdkFiles.confirmed_transactions,
		});
		if (res.isOk()) {
			return parseData(
				res.value.content,
				DefaultLdkDataShape.confirmed_transactions,
			);
		}
		return DefaultLdkDataShape.confirmed_transactions;
	};

	/**
	 * Returns previously confirmed outputs from storage.
	 * @returns {Promise<TLdkConfirmedOutputs>}
	 */
	private getLdkConfirmedOutputs = async (): Promise<TLdkConfirmedOutputs> => {
		const res = await ldk.readFromFile({
			fileName: ELdkFiles.confirmed_outputs,
		});
		if (res.isOk()) {
			return parseData(
				res.value.content,
				DefaultLdkDataShape.confirmed_outputs,
			);
		}
		return DefaultLdkDataShape.confirmed_outputs;
	};

	/**
	 * Returns previously broadcasted transactions saved in storgare.
	 * @returns {Promise<TLdkBroadcastedTransactions>}
	 */
	private getLdkBroadcastedTxs =
		async (): Promise<TLdkBroadcastedTransactions> => {
			const res = await ldk.readFromFile({
				fileName: ELdkFiles.broadcasted_transactions,
			});
			if (res.isOk()) {
				return parseData(
					res.value.content,
					DefaultLdkDataShape.broadcasted_transactions,
				);
			}
			return DefaultLdkDataShape.broadcasted_transactions;
		};

	/**
	 * Saves confirmed transaction txids to storage.
	 * @param {string} txid
	 * @returns {Promise<void>}
	 */
	private saveConfirmedTxs = async (txid: string): Promise<Result<boolean>> => {
		if (!txid) {
			return ok(true);
		}
		const confirmedTxs = await this.getLdkConfirmedTxs();
		if (!confirmedTxs.includes(txid)) {
			confirmedTxs.push(txid);
			return await ldk.writeToFile({
				fileName: ELdkFiles.confirmed_transactions,
				content: JSON.stringify(confirmedTxs),
			});
		}
		return ok(true);
	};

	/**
	 * Saves confirmed output script_pubkeys to storage.
	 * @param {string} script_pubkey
	 * @returns {Promise<Result<boolean>>}
	 */
	private saveConfirmedOutputs = async (
		script_pubkey: string,
	): Promise<Result<boolean>> => {
		if (!script_pubkey) {
			return ok(true);
		}
		const confirmedOutputs = await this.getLdkConfirmedOutputs();
		if (!confirmedOutputs.includes(script_pubkey)) {
			confirmedOutputs.push(script_pubkey);
			return await ldk.writeToFile({
				fileName: ELdkFiles.confirmed_outputs,
				content: JSON.stringify(confirmedOutputs),
			});
		}
		return ok(true);
	};

	/**
	 * Saves broadcasted transactions to storage.
	 * @param {string} rawTx
	 * @returns {Promise<void>}
	 */
	private saveBroadcastedTxs = async (
		rawTx: string,
	): Promise<Result<boolean>> => {
		if (!rawTx) {
			return ok(true);
		}
		const broadcastedTransactions = await this.getLdkBroadcastedTxs();
		if (!broadcastedTransactions.includes(rawTx)) {
			broadcastedTransactions.push(rawTx);
			return await ldk.writeToFile({
				fileName: ELdkFiles.broadcasted_transactions,
				content: JSON.stringify(broadcastedTransactions),
			});
		}
		return ok(true);
	};

	/**
	 * Adds an individual peer to storage.
	 * @param {TPeer} peer
	 * @returns {Promise<void>}
	 */
	private saveLdkPeerData = async (peer: TPeer): Promise<Result<boolean>> => {
		const peers = await this.getPeers();
		const duplicatePeerArr = peers.filter(
			(p) => p.pubKey === peer.pubKey && p.address === peer.address,
		);
		if (duplicatePeerArr.length > 0) {
			return ok(true);
		}
		peers.push(peer);

		return await ldk.writeToFile({
			fileName: ELdkFiles.peers,
			content: JSON.stringify(peers),
		});
	};

	//LDK events

	private async onRegisterTx(res: TRegisterTxEvent): Promise<void> {
		const isDuplicate = this.watchTxs.some(
			(tx) => tx.script_pubkey === res.script_pubkey && tx.txid === res.txid,
		);
		const confirmedTxs = await this.getLdkConfirmedTxs();
		const isAlreadyConfirmed = confirmedTxs.includes(res.txid);
		if (!isDuplicate && !isAlreadyConfirmed) {
			this.watchTxs.push(res);
		}
	}

	private async onRegisterOutput(res: TRegisterOutputEvent): Promise<void> {
		const isDuplicate = this.watchOutputs.some(
			(o) => o.script_pubkey === res.script_pubkey && o.index === res.index,
		);
		const confirmedOutputs = await this.getLdkConfirmedOutputs();
		const isAlreadyConfirmed = confirmedOutputs.includes(res.script_pubkey);
		if (!isDuplicate && !isAlreadyConfirmed) {
			this.watchOutputs.push(res);
		}
	}

	private async onBroadcastTransaction(
		res: TBroadcastTransactionEvent,
	): Promise<void> {
		const broadcastedTxs = await this.getLdkBroadcastedTxs();
		if (broadcastedTxs.includes(res.tx)) {
			return;
		}
		console.log(`onBroadcastTransaction: ${res.tx}`);
		this.broadcastTransaction(res.tx).then(console.log);
		this.saveBroadcastedTxs(res.tx).then();
	}

	//LDK channel manager events
	//All events and their values: https://docs.rs/lightning/latest/lightning/util/events/enum.Event.html
	//Sample node for examples on how to handle events: https://github.com/lightningdevkit/ldk-sample/blob/c0a722430b8fbcb30310d64487a32aae839da3e8/src/main.rs#L600
	private onChannelManagerFundingGenerationReady(
		res: TChannelManagerFundingGenerationReady,
	): void {
		console.log(
			`onChannelManagerFundingGenerationReady: ${JSON.stringify(res)}`,
		); //TODO
	}

	private onChannelManagerPaymentReceived(res: TChannelManagerPayment): void {
		if (res.spontaneous_payment_preimage) {
			//https://docs.rs/lightning/latest/lightning/util/events/enum.PaymentPurpose.html#variant.SpontaneousPayment
			ldk.claimFunds(res.spontaneous_payment_preimage).catch(console.error);
		} else {
			ldk.claimFunds(res.payment_preimage).catch(console.error);
		}
	}

	private onChannelManagerPaymentSent(res: TChannelManagerPaymentSent): void {
		//Nothing to do but notify user
		console.log(`onChannelManagerPaymentSent: ${JSON.stringify(res)}`); //TODO
	}

	private onChannelManagerOpenChannelRequest(
		res: TChannelManagerOpenChannelRequest,
	): void {
		//Nothing to do here unless manuallyAcceptInboundChannels:true in initConfig() above
		console.log(`onChannelManagerOpenChannelRequest: ${JSON.stringify(res)}`);
	}

	private onChannelManagerPaymentPathSuccessful(
		res: TChannelManagerPaymentPathSuccessful,
	): void {
		//Nothing to do here. Optionally notify user?
		console.log(
			`onChannelManagerPaymentPathSuccessful: ${JSON.stringify(res)}`,
		); //TODO
	}

	private onChannelManagerPaymentPathFailed(
		res: TChannelManagerPaymentPathFailed,
	): void {
		console.log(`onChannelManagerPaymentPathFailed: ${JSON.stringify(res)}`); //TODO
	}

	private onChannelManagerPaymentFailed(
		res: TChannelManagerPaymentFailed,
	): void {
		console.log(`onChannelManagerPaymentFailed: ${JSON.stringify(res)}`); //TODO
	}

	private onChannelManagerPendingHtlcsForwardable(
		res: TChannelManagerPendingHtlcsForwardable,
	): void {
		ldk.processPendingHtlcForwards().catch(console.error);
	}

	private async onChannelManagerSpendableOutputs(
		res: TChannelManagerSpendableOutputs,
	): Promise<void> {
		const address = await this.getAddress();
		const change_destination_script = this.getChangeDestinationScript(address);
		if (!change_destination_script) {
			console.log('Unable to retrieve change_destination_script.');
			return;
		}
		const spendRes = await ldk.spendOutputs({
			descriptorsSerialized: res.outputsSerialized,
			outputs: [], //Shouldn't need to specify this if we're sweeping all funds to dest script
			change_destination_script,
			feerate_sat_per_1000_weight: this.feeRate,
		});

		if (spendRes.isErr()) {
			//TODO should we notify user?
			console.error(spendRes.error);
			return;
		}

		this.onBroadcastTransaction({ tx: spendRes.value });

		console.log(`onChannelManagerSpendableOutputs: ${JSON.stringify(res)}`); //TODO
	}

	private onChannelManagerChannelClosed(
		res: TChannelManagerChannelClosed,
	): void {
		console.log(`onChannelManagerChannelClosed: ${JSON.stringify(res)}`);
	}

	private onChannelManagerDiscardFunding(
		res: TChannelManagerDiscardFunding,
	): void {
		//Wallet should probably "lock" the UTXOs spent in funding transactions until the funding transaction either confirms, or this event is generated.
		console.log(`onChannelManagerDiscardFunding: ${JSON.stringify(res)}`); //TODO
	}

	private onChannelManagerPaymentClaimed(res: TChannelManagerPayment): void {
		// Payment Received/Invoice Paid.
		console.log(`onChannelManagerPaymentClaimed: ${JSON.stringify(res)}`);
		this.syncLdk().then();
	}

	/**
	 * Best effort attempt to recover funds in the event that a channel monitor is
	 * not able to be persisted.
	 * @param res
	 * @returns {Promise<void>}
	 */
	private async onEmergencyForceCloseChannel(
		res: TEmergencyForceCloseChannel,
	): Promise<void> {
		console.warn('Emergency close channel');
		const { channel_id, counterparty_node_id } = res;
		const closeRes = await ldk.closeChannel({
			channelId: channel_id,
			counterPartyNodeId: counterparty_node_id,
			force: true,
		});
		if (closeRes.isErr()) {
			return console.error(closeRes.error);
		}

		console.log(
			`Emergency closed channel ${channel_id} with peer ${counterparty_node_id}`,
		);
	}
}

export default new LightningManager();
