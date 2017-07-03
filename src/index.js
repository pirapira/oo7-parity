import {Bond, TimeBond, TransformBond as oo7TransformBond, ReactivePromise} from 'oo7';
import BigNumber from 'bignumber.js';
// For dev-only (use local version not npm)
//const Parity = window.parity;
require('@parity/parity.js');

import { abiPolyfill, RegistryABI, RegistryExtras, GitHubHintABI, OperationsABI,
	BadgeRegABI, TokenRegABI, BadgeABI, TokenABI } from './abis.js';

// DEPRECATED. TODO: REMOVE
export function setupBonds(_api = parity.api) {
	return createBonds({ api: _api });
}

function httpTransport() {
	var transport;

	// Check to see if there's already a parity object injected in window.
	if (window && window.parity && window.parity.api.transport._url && window.location.protocol.match('^https?:$')) {
		transport = new Parity.Api.Transport.Http(
			window.parity.api.transport._url[0] === '/'
				? window.location.protocol + '//' + window.location.host + window.parity.api.transport._url
			: window.parity.api.transport._url.contains('://')
				? window.parity.api.transport._url
				: window.location.href + window.parity.api.transport._url
		);
	}

	// Fallback to localhost:8545
	if (!transport) {
		transport = new Parity.Api.Transport.Http('http://localhost:8545');
	}

	return transport;
}

// Pubsub websocket transport
function defaultTransport(){
	var transport;

	// Check to see if there's already a parity object injected in window.
	if (window && window.parity && window.parity.api.transport._url && window.location.protocol.match('^wss?:$')) {
		transport = new Parity.Api.Transport.Ws(
			window.parity.api.transport._url[0] === '/'
				? window.location.protocol + '//' + window.location.host + window.parity.api.transport._url
			: window.parity.api.transport._url.contains('://')
				? window.parity.api.transport._url
				: window.location.href + window.parity.api.transport._url
		);
	}

	// Fallback to localhost:8546
	if (!transport){
		transport = new Parity.Api.Transport.Ws('ws://localhost:8546');
	}

	return transport;
}

export function Bonds(transport = defaultTransport()) {
	return createBonds({ api: new Parity.Api(transport) });
}

function createBonds(options) {
	var bonds = {};

	// We only ever use api() at call-time of this function; this allows the
	// options (particularly the transport option) to be changed dynamically
	// and the datastructure to be reused.
	const api = () => options.api;
	const util = Parity.Api.util;

	// Deprecated - remove once all code moved over to avoid parity.api.abi.
	if (!api().abi) {
		api().abi = abiPolyfill();
	}

	class TransformBond extends oo7TransformBond {
		constructor (f, a = [], d = [], outResolveDepth = 0, resolveDepth = 1, latched = true, mayBeNull = true) {
			super(f, a, d, outResolveDepth, resolveDepth, latched, mayBeNull, api());
		}
		map (f, outResolveDepth = 0, resolveDepth = 1) {
	        return new TransformBond(f, [this], [], outResolveDepth, resolveDepth);
	    }
		sub (name, outResolveDepth = 0, resolveDepth = 1) {
			return new TransformBond((r, n) => r[n], [this, name], [], outResolveDepth, resolveDepth);
		}
		static all(list) {
			return new TransformBond((...args) => args, list);
		}
	}

	class SubscriptionBond extends Bond {
		constructor(rpcName, options = []) {
			super();
			this.rpcName = rpcName;
			this.options = [(_,n) => this.trigger(n), ...options];
		}
		initialise () {
			// promise instead of id because if a dependency triggers finalise() before id's promise is resolved the unsubscribing would call with undefined
			this.subscription = api().pubsub[this.rpcName](...this.options);
		}
		finalise () {
			this.subscription.then(id => api().pubsub.unsubscribe([id]));
		}
		map (f, outResolveDepth = 0, resolveDepth = 1) {
			return new TransformBond(f, [this], [], outResolveDepth, resolveDepth);
		}
		sub (name, outResolveDepth = 0, resolveDepth = 1) {
			return new TransformBond((r, n) => r[n], [this, name], [], outResolveDepth, resolveDepth);
		}
		static all(list) {
			return new TransformBond((...args) => args, list);
		}
	}

	class Signature extends ReactivePromise {
		constructor(message, from) {
			super([message, from], [], ([message, from]) => {
				api().parity.postSign(from, util.asciiToHex(message))
					.then(signerRequestId => {
						this.trigger({requested: signerRequestId});
				    	return api().pollMethod('parity_checkRequest', signerRequestId);
				    })
				    .then(signature => {
						this.trigger({
							signed: splitSignature(signature)
						});
					})
					.catch(error => {
						console.error(error);
						this.trigger({failed: error});
					});
			}, false);
			this.then(_ => null);
		}
		isDone(s) {
			return !!s.failed || !!s.signed;
		}
	}

	function transactionPromise(tx, progress, f) {
		progress({initialising: null});
		Promise.all([api().eth.accounts(), api().eth.gasPrice()])
			.then(([a, p]) => {
				progress({estimating: null});
				tx.from = tx.from || a[0];
				tx.gasPrice = tx.gasPrice || p;
				return api().eth.estimateGas(tx);
			})
			.then(g => {
				progress({estimated: g});
				tx.gas = tx.gas || g;
				return api().parity.postTransaction(tx);
			})
			.then(signerRequestId => {
				progress({requested: signerRequestId});
				return api().pollMethod('parity_checkRequest', signerRequestId);
			})
			.then(transactionHash => {
				progress({signed: transactionHash});
				return api().pollMethod('eth_getTransactionReceipt', transactionHash, (receipt) => receipt && receipt.blockNumber && !receipt.blockNumber.eq(0));
			})
			.then(receipt => {
				progress(f({confirmed: receipt}));
				return receipt;
			})
			.catch(error => {
				progress({failed: error});
			});
	}

	class Transaction extends ReactivePromise {
		constructor(tx) {
			super([tx], [], ([tx]) => {
				let progress = this.trigger.bind(this);
				transactionPromise(tx, progress, _ => _);
			}, false);
			this.then(_ => null);
		}
		isDone(s) {
			return !!(s.failed || s.confirmed);
		}
	}

	function overlay(base, top) {
		Object.keys(top).forEach(k => {
			base[k] = top[k];
		});
		return base;
	}

	function memoized(f) {
		var memo;
		return function() {
			if (memo === undefined)
				memo = f();
			return memo;
		};
	}

	function call(addr, method, args, options) {
		let data = util.abiEncode(method.name, method.inputs.map(f => f.type), args);
		let decode = d => util.abiDecode(method.outputs.map(f => f.type), d);
		return api().eth.call(overlay({to: addr, data: data}, options)).then(decode);
	};

	function post(addr, method, args, options) {
		let toOptions = (addr, method, options, ...args) => {
			return overlay({to: addr, data: util.abiEncode(method.name, method.inputs.map(f => f.type), args)}, options);
		};
		return new Transaction(toOptions.bond(addr, method, options, ...args));
	};

	bonds.time = new TimeBond;
	bonds.height = new TransformBond(_=>+_, [new SubscriptionBond('blockNumber')]).subscriptable();
	bonds.accounts = new SubscriptionBond('accounts').subscriptable();
	bonds.hardwareAccountsInfo = new SubscriptionBond('hardwareAccountsInfo').subscriptable(2);
	bonds.accountsInfo = new SubscriptionBond('accountsInfo').subscriptable(2);
	bonds.defaultAccount = new SubscriptionBond('defaultAccount').subscriptable();
	bonds.netPeers = new SubscriptionBond('netPeers').subscriptable();
	bonds.pendingTransactions = new SubscriptionBond('pendingTransactions').subscriptable();
	bonds.unsignedTransactionCount = new SubscriptionBond('unsignedTransactionsCount').subscriptable();
	//bonds.allAccountsInfo = new SubscriptionBond('parity_allAccountsInfo');
	//bonds.requestsToConfirm = new SubscriptionBond('signer_requestsToConfirm');

	let onAccountsChanged = bonds.accounts;	// TODO: Having pubsub method to retrieve allAccountsInfo (In progress - parity_accounts not enabled yet)
	bonds.allAccountsInfo = new TransformBond(() => api().parity.allAccountsInfo(), [], [onAccountsChanged]).subscriptable();

	Function.__proto__.bond = function(...args) { return new TransformBond(this, args); };
	Function.__proto__.unlatchedBond = function(...args) { return new TransformBond(this, args, [], false, undefined); };
	Function.__proto__.timeBond = function(...args) { return new TransformBond(this, args, [bonds.time]); };
	Function.__proto__.blockBond = function(...args) { return new TransformBond(this, args, [bonds.height]); };

	let presub = function (f) {
		return new Proxy(f, {
			get (receiver, name) {
				if (typeof(name) === 'string' || typeof(name) === 'number') {
					return typeof(receiver[name]) !== 'undefined' ? receiver[name] : receiver(name);
				} else if (typeof(name) === 'symbol' && Bond.knowSymbol(name)) {
					return receiver(Bond.fromSymbol(name));
				} else {
					throw `Weird value type to be subscripted by: ${typeof(name)}: ${JSON.stringify(name)}`;
				}
			}
		});
	};

	function isNumber(n) { return typeof(n) === 'number' || (typeof(n) === 'string' && n.match(/^[0-9]+$/)); }

	let onAutoUpdateChanged = bonds.height;

	// eth_
	bonds.blockNumber = bonds.height;
	bonds.blockByNumber = (numberBond => new TransformBond(number => new SubscriptionBond('getBlockByNumber', [number]), [numberBond]).subscriptable());
	bonds.blockByHash = (x => new TransformBond(x => new SubscriptionBond('getBlockByHash', [x]), [x]).subscriptable());
	bonds.findBlock = (hashOrNumberBond => new TransformBond(hashOrNumber => isNumber(hashOrNumber)
		? new SubscriptionBond('getBlockByNumber', [hashOrNumber])
		: new SubscriptionBond('getBlockByHash', [hashOrNumber]),
		[hashOrNumberBond]).subscriptable());
	bonds.blocks = presub(bonds.findBlock);
	bonds.block = bonds.blockByNumber(bonds.height);	// TODO: DEPRECATE AND REMOVE
	bonds.head = new SubscriptionBond('getBlockByNumber', ['latest']).subscriptable();
	bonds.author = new SubscriptionBond('coinbase');
	//bonds.accounts = new TransformBond(a => a.map(util.toChecksumAddress), [new TransformBond(() => api().eth.accounts(), [], [onAccountsChanged])]).subscriptable();
	//bonds.defaultAccount = bonds.accounts[0];	// TODO: make this use its subscription
	bonds.me = new SubscriptionBond('defaultAccount');
	bonds.post = tx => new Transaction(tx);
	bonds.sign = (message, from = bonds.me) => new Signature(message, from);

	bonds.balance = (x => new TransformBond(x => new SubscriptionBond('getBalance', [x]), [x]));
	bonds.code = (x => new TransformBond(x => new SubscriptionBond('getCode', [x]), [x]));
	bonds.nonce = (x => new TransformBond(x => new SubscriptionBond('getTransactionCount', [x]), [x])); // TODO: then(_ => +_) Depth 2 if second TransformBond or apply to result
	bonds.storageAt = ((x, y) => new TransformBond((x, y) => new SubscriptionBond('getStorageAt', [x, y]), [x, y]));

	bonds.syncing = new SubscriptionBond('syncing');
	bonds.hashrate = new SubscriptionBond('hashrate');
	bonds.authoring = new SubscriptionBond('mining');
	bonds.ethProtocolVersion = new SubscriptionBond('protocolVersion');
	bonds.gasPrice = new SubscriptionBond('gasPrice');
	bonds.estimateGas = (x => new TransformBond(x => new SubscriptionBond('estimateGas', [x]), [x]));

	bonds.blockTransactionCount = (hashOrNumberBond => new TransformBond(
		hashOrNumber => isNumber(hashOrNumber)
			? new TransformBond(_=>+_, [new SubscriptionBond('getBlockTransactionCountByNumber', [hashOrNumber])])
			: new TransformBond(_=>+_, [new SubscriptionBond('getBlockTransactionCountByHash', [hashOrNumber])]),
		[hashOrNumberBond]));
	bonds.uncleCount = (hashOrNumberBond => new TransformBond(
		hashOrNumber => isNumber(hashOrNumber)
			? new TransformBond(_=>+_, [new SubscriptionBond('getUncleCountByBlockNumber', [hashOrNumber])])
			: new TransformBond(_=>+_, [new SubscriptionBond('getUncleCountByBlockHash', [hashOrNumber])]),
		[hashOrNumberBond]).subscriptable());
	bonds.uncle = ((hashOrNumberBond, indexBond) => new TransformBond(
		(hashOrNumber, index) => isNumber(hashOrNumber)
			? new SubscriptionBond('getUncleByBlockNumberAndIndex', [hashOrNumber, index])
			: new SubscriptionBond('getUncleByBlockHashAndIndex', [hashOrNumber, index]),
		[hashOrNumberBond, indexBond]).subscriptable());

	bonds.transaction = ((hashOrNumberBond, indexOrNullBond) => new TransformBond(
		(hashOrNumber, indexOrNull) =>
			indexOrNull === undefined || indexOrNull === null
				? new SubscriptionBond('getTransactionByHash', [hashOrNumber])
				: isNumber(hashOrNumber)
					? new SubscriptionBond('getTransactionByBlockNumberAndIndex', [hashOrNumber, indexOrNull])
					: new SubscriptionBond('getTransactionByBlockHashAndIndex', [hashOrNumber, indexOrNull]),
			[hashOrNumberBond, indexOrNullBond]).subscriptable());
	bonds.receipt = (hashBond => new TransformBond(x => new SubscriptionBond('getTransactionReceipt', [x]), [hashBond]).subscriptable());

	// web3_
	bonds.clientVersion = new TransformBond(() => api().web3.clientVersion(), [], []);

	// net_
	bonds.peerCount = new TransformBond(_=>+_, [new SubscriptionBond('peerCount')]);
	bonds.listening = new SubscriptionBond('listening');
	bonds.chainId = new SubscriptionBond('version');

	// parity_
	bonds.hashContent = (u => new TransformBond(x => api().parity.hashContent(x), [u], [], false));
	bonds.gasPriceHistogram = new SubscriptionBond('gasPriceHistogram').subscriptable();
	bonds.mode = new SubscriptionBond('mode');

	// ...authoring
	bonds.defaultExtraData = new SubscriptionBond('defaultExtraData');
	bonds.extraData = new SubscriptionBond('extraData');
	bonds.gasCeilTarget = new SubscriptionBond('gasCeilTarget');
	bonds.gasFloorTarget = new SubscriptionBond('gasFloorTarget');
	bonds.minGasPrice = new SubscriptionBond('minGasPrice');
	bonds.transactionsLimit = new SubscriptionBond('transactionsLimit');

	// ...chain info
	bonds.chainName = new SubscriptionBond('netChain');
	bonds.chainStatus = new SubscriptionBond('chainStatus').subscriptable();

	// ...networking
	bonds.peers = new SubscriptionBond('netPeers').subscriptable(2);
	bonds.enode = new SubscriptionBond('enode');
	bonds.nodePort = new TransformBond(_=>+_, [new SubscriptionBond('netPort')]);
	bonds.nodeName = new SubscriptionBond('nodeName');
	// Where defined ?
	bonds.signerPort = new TransformBond(() => api().parity.signerPort().then(_=>+_), [], []);
	bonds.dappsPort = new TransformBond(() => api().parity.dappsPort().then(_=>+_), [], []);
	bonds.dappsInterface = new TransformBond(() => api().parity.dappsInterface(), [], []);

	// ...transaction queue
	bonds.nextNonce = new TransformBond(_=>+_, [new SubscriptionBond('nextNonce')]);
	bonds.pending = new SubscriptionBond('pendingTransactions');
	bonds.local = new SubscriptionBond('localTransactions').subscriptable(3);
	bonds.future = new SubscriptionBond('futureTransactions').subscriptable(2);
	bonds.pendingStats = new SubscriptionBond('pendingTransactionsStats').subscriptable(2);
	bonds.unsignedCount = new TransformBond(_=>+_, [new SubscriptionBond('unsignedTransactionsCount')]);

	// ...auto-update
	bonds.releasesInfo = new SubscriptionBond('releasesInfo').subscriptable();
	bonds.versionInfo = new SubscriptionBond('versionInfo').subscriptable();
	bonds.consensusCapability = new SubscriptionBond('consensusCapability').subscriptable();
	bonds.upgradeReady = new TransformBond(() => api().parity.upgradeReady(), [], [onAutoUpdateChanged]).subscriptable();

	// trace
	bonds.replayTx = ((x,whatTrace) => new TransformBond((x,whatTrace) => api().trace.replayTransaction(x, whatTrace), [x, whatTrace], []).subscriptable());
	bonds.callTx = ((x,whatTrace,blockNumber) => new TransformBond((x,whatTrace,blockNumber) => api().trace.call(x, whatTrace, blockNumber), [x, whatTrace, blockNumber], []).subscriptable());

	class DeployContract extends ReactivePromise {
		constructor(initBond, abiBond, optionsBond) {
			super([initBond, abiBond, optionsBond, bonds.registry], [], ([init, abi, options, registry]) => {
				options.data = init;
				delete options.to;
				let progress = this.trigger.bind(this);
				transactionPromise(options, progress, status => {
					if (status.confirmed) {
						status.deployed = bonds.makeContract(status.confirmed.contractAddress, abi, options.extras || []);
					}
					return status;
				});
				// TODO: consider allowing registry of the contract here.
			}, false);
			this.then(_ => null);
		}
		isDone(s) {
			return !!(s.failed || s.confirmed);
		}
	}

	bonds.deployContract = function(init, abi, options = {}) {
		return new DeployContract(init, abi, options);
	}

	bonds.makeContract = function(address, abi, extras = []) {
		var r = { address: address };
		let unwrapIfOne = a => a.length == 1 ? a[0] : a;
		abi.forEach(i => {
			if (i.type == 'function' && i.constant) {
				let f = function (...args) {
					var options = args.length === i.inputs.length + 1 ? args.unshift() : {};
					if (args.length != i.inputs.length)
						throw `Invalid number of arguments to ${i.name}. Expected ${i.inputs.length}, got ${args.length}.`;
					let f = (addr, ...fargs) => call(addr, i, fargs, options)
						.then(rets => rets.map((r, o) => cleanup(r, i.outputs[o].type, api)))
						.then(unwrapIfOne);
					return new TransformBond(f, [address, ...args], [bonds.height]).subscriptable();	// TODO: should be subscription on contract events
				};
				r[i.name] = (i.inputs.length === 0) ? memoized(f) : (i.inputs.length === 1) ? presub(f) : f;
			}
		});
		extras.forEach(i => {
			let f = function (...args) {
				let expectedInputs = (i.numInputs || i.args.length);
				var options = args.length === expectedInputs + 1 ? args.unshift() : {};
				if (args.length != expectedInputs)
					throw `Invalid number of arguments to ${i.name}. Expected ${expectedInputs}, got ${args.length}.`;
				let c = abi.find(j => j.name == i.method);
				let f = (addr, ...fargs) => {
					let args = i.args.map((v, index) => v === null ? fargs[index] : typeof(v) === 'function' ? v(fargs[index]) : v);
					return call(addr, c, args, options).then(unwrapIfOne);
				};
				return new TransformBond(f, [address, ...args], [bonds.height]).subscriptable();	// TODO: should be subscription on contract events
			};
			r[i.name] = (i.args.length === 1) ? presub(f) : f;
		});
		abi.forEach(i => {
			if (i.type == 'function' && !i.constant) {
				r[i.name] = function (...args) {
					var options = args.length === i.inputs.length + 1 ? args.pop() : {};
					if (args.length !== i.inputs.length)
						throw `Invalid number of arguments to ${i.name}. Expected ${i.inputs.length}, got ${args.length}.`;
					return post(address, i, args, options).subscriptable();
				};
			}
		});
		var eventLookup = {};
		abi.filter(i => i.type == 'event').forEach(i => {
			eventLookup[util.abiSignature(i.name, i.inputs.map(f => f.type))] = i.name;
		});

		function prepareIndexEncode(v, t, top = true) {
			if (v instanceof Array) {
				if (top) {
					return v.map(x => prepareIndexEncode(x, t, false));
				} else {
					throw 'Invalid type';
				}
			}
			var val;
			if (t == 'string' || t == 'bytes') {
				val = util.sha3(v);
			} else {
				val = util.abiEncode(null, [t], [v]);
			}
			if (val.length != 66) {
				throw 'Invalid length';
			}
			return val;
		}

		abi.forEach(i => {
			if (i.type == 'event') {
				r[i.name] = function (indexed = {}, params = {}) {
					return new TransformBond((addr, indexed) => {
						var topics = [util.abiSignature(i.name, i.inputs.map(f => f.type))];
						i.inputs.filter(f => f.indexed).forEach(f => {
							try {
								topics.push(indexed[f.name] ? prepareIndexEncode(indexed[f.name], f.type) : null);
							}
							catch (e) {
								throw `Couldn't encode indexed parameter ${f.name} of type ${f.type} with value ${indexed[f.name]}`;
							}
						});
						return api().eth.getLogs({
							address: addr,
							fromBlock: params.fromBlock || 0,
							toBlock: params.toBlock || 'pending',
							limit: params.limit || 10,
							topics: topics
						}).then(logs => logs.map(l => {
							l.blockNumber = +l.blockNumber;
							l.transactionIndex = +l.transactionIndex;
							l.logIndex = +l.logIndex;
							l.transactionLogIndex = +l.transactionLogIndex;
							var e = {};
							let unins = i.inputs.filter(f => !f.indexed);
							util.abiDecode(unins.map(f => f.type), l.data).forEach((v, j) => {
								let f = unins[j];
								if (v instanceof Array && !f.type.endsWith(']')) {
									v = util.bytesToHex(v);
								}
								if (f.type.substr(0, 4) == 'uint' && +f.type.substr(4) <= 48) {
									v = +v;
								}
								e[f.name] = v;
							});
							i.inputs.filter(f => f.indexed).forEach((f, j) => {
								if (f.type == 'string' || f.type == 'bytes') {
									e[f.name] = l.topics[1 + j];
								} else {
									var v = util.abiDecode([f.type], l.topics[1 + j])[0];
									if (v instanceof Array) {
										v = util.bytesToHex(v);
									}
									if (f.type.substr(0, 4) == 'uint' && +f.type.substr(4) <= 48) {
										v = +v;
									}
									e[f.name] = v;
								}
							});
							e.event = eventLookup[l.topics[0]];
							e.log = l;
							return e;
						}));
					}, [address, indexed], [bonds.height]).subscriptable();
				};
			}
		});
		return r;
	};

	bonds.registry = bonds.makeContract(new TransformBond(() => api().parity.registryAddress(), [], [bonds.time]), RegistryABI, RegistryExtras);	// TODO should be subscription.
	bonds.githubhint = bonds.makeContract(bonds.registry.lookupAddress('githubhint', 'A'), GitHubHintABI);
	bonds.operations = bonds.makeContract(bonds.registry.lookupAddress('operations', 'A'), OperationsABI);
	bonds.badgereg = bonds.makeContract(bonds.registry.lookupAddress('badgereg', 'A'), BadgeRegABI);
	bonds.tokenreg = bonds.makeContract(bonds.registry.lookupAddress('tokenreg', 'A'), TokenRegABI);

	bonds.badges = new TransformBond(n => {
		var ret = [];
		for (var i = 0; i < +n; ++i) {
			let id = i;
			ret.push(Bond.all([
					bonds.badgereg.badge(id),
					bonds.badgereg.meta(id, 'IMG'),
					bonds.badgereg.meta(id, 'CAPTION')
				]).map(([[addr, name, owner], img, caption]) => ({
					id,
					name,
					img,
					caption,
					badge: bonds.makeContract(addr, BadgeABI)
				}))
			);
		}
		return ret;
	}, [bonds.badgereg.badgeCount()], [], 1);

	bonds.badgesOf = address => new TransformBond(
		(addr, bads) => bads.map(b => ({
			certified: b.badge.certified(addr),
			badge: b.badge,
			id: b.id,
			img: b.img,
			caption: b.caption,
			name: b.name
		})),
		[address, bonds.badges], [], 2
	).map(all => all.filter(_=>_.certified));

	bonds.namesOf = address => new TransformBond((reg, addr, accs) => ({
		owned: accs[addr] ? accs[addr].name : null,
		registry: reg || null
	}), [bonds.registry.reverse(address), address, bonds.accountsInfo]);

	bonds.registry.names = Bond.mapAll([bonds.registry.ReverseConfirmed({}, {limit: 100}), bonds.accountsInfo],
		(reg, info) => {
			let r = {};
			Object.keys(info).forEach(k => r[k] = info[k].name);
			reg.forEach(a => r[a.reverse] = bonds.registry.reverse(a.reverse));
			return r;
		}, 1)

	return bonds;
}

export var options = { api: new Parity.Api(defaultTransport()) };
export const bonds = createBonds(options);

export const asciiToHex = Parity.Api.util.asciiToHex;
export const bytesToHex = Parity.Api.util.bytesToHex;
export const hexToAscii = Parity.Api.util.hexToAscii;
export const isAddressValid = Parity.Api.util.isAddressValid;
export const sha3 = Parity.Api.util.sha3;
export const toChecksumAddress = Parity.Api.util.toChecksumAddress;

// Deprecated.
export { abiPolyfill };

export { RegistryABI, RegistryExtras, GitHubHintABI, OperationsABI,
	BadgeRegABI, TokenRegABI, BadgeABI, TokenABI };


////
// Parity Utilities

// TODO: move to parity.js, repackage or repot.

export function capitalizeFirstLetter(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function singleton(f) {
    var instance = null;
    return function() {
        if (instance === null)
            instance = f();
        return instance;
    }
}

export const denominations = [ "wei", "Kwei", "Mwei", "Gwei", "szabo", "finney", "ether", "grand", "Mether", "Gether", "Tether", "Pether", "Eether", "Zether", "Yether", "Nether", "Dether", "Vether", "Uether" ];

export function denominationMultiplier(s) {
    let i = denominations.indexOf(s);
    if (i < 0)
        throw "Invalid denomination";
    return (new BigNumber(1000)).pow(i);
}

export function interpretRender(s, defaultDenom = 6) {
    try {
        let m = s.toLowerCase().match(/([0-9,]+)(\.([0-9]*))? *([a-zA-Z]+)?/);
		let di = m[4] ? denominations.indexOf(m[4]) : defaultDenom;
		if (di === -1) {
			return null;
		}
		let n = (m[1].replace(',', '').replace(/^0*/, '')) || '0';
		let d = (m[3] || '').replace(/0*$/, '');
		return { denom: di, units: n, decimals: d, origNum: m[1] + (m[2] || ''), origDenom: m[4] || '' };
    }
    catch (e) {
        return null;
    }
}

export function combineValue(v) {
	let d = (new BigNumber(1000)).pow(v.denom);
	let n = v.units;
	if (v.decimals) {
		n += v.decimals;
		d = d.div((new BigNumber(10)).pow(v.decimals.length));
	}
	return new BigNumber(n).mul(d);
}

export function defDenom(v, d) {
	if (v.denom === null) {
		v.denom = d;
	}
	return v;
}

export function formatValue(n) {
	return `${formatValueNoDenom(n)} ${denominations[n.denom]}`;
}

export function formatValueNoDenom(n) {
	return `${n.units.toString().replace(/(\d)(?=(\d{3})+$)/g, "$1,")}${n.decimals ? '.' + n.decimals : ''}`;
}

export function interpretQuantity(s) {
    try {
        let m = s.toLowerCase().match(/([0-9,]+)(\.([0-9]*))? *([a-zA-Z]+)?/);
        let d = denominationMultiplier(m[4] || 'ether');
        let n = +m[1].replace(',', '');
		if (m[2]) {
			n += m[3];
			for (let i = 0; i < m[3].length; ++i) {
	            d = d.div(10);
	        }
		}
        return new BigNumber(n).mul(d);
    }
    catch (e) {
        return null;
    }
}

export function splitValue(a) {
	var i = 0;
	var a = new BigNumber('' + a);
	if (a.gte(new BigNumber("10000000000000000")) && a.lt(new BigNumber("100000000000000000000000")) || a.eq(0))
		i = 6;
	else
		for (var aa = a; aa.gte(1000) && i < denominations.length - 1; aa = aa.div(1000))
			i++;

	for (var j = 0; j < i; ++j)
		a = a.div(1000);

	return {base: a, denom: i};
}

export function formatBalance(n) {
	let a = splitValue(n);
//	let b = Math.floor(a.base * 1000) / 1000;
	return `${a.base} ${denominations[a.denom]}`;
}

export function formatBlockNumber(n) {
    return '#' + ('' + n).replace(/(\d)(?=(\d{3})+$)/g, "$1,");
}

export function isNullData(a) {
	return !a || typeof(a) !== 'string' || a.match(/^(0x)?0+$/) !== null;
}

export function splitSignature (sig) {
	if ((sig.substr(2, 2) === '1b' || sig.substr(2, 2) === '1c') && (sig.substr(66, 2) !== '1b' && sig.substr(66, 2) !== '1c')) {
		// vrs
		return [sig.substr(0, 4), `0x${sig.substr(4, 64)}`, `0x${sig.substr(68, 64)}`];
	} else {
		// rsv
		return [`0x${sig.substr(130, 2)}`, `0x${sig.substr(2, 64)}`, `0x${sig.substr(66, 64)}`];
	}
};

export function removeSigningPrefix (message) {
	if (!message.startsWith('\x19Ethereum Signed Message:\n')) {
		throw 'Invalid message - doesn\'t contain security prefix';
	}
	for (var i = 1; i < 6; ++i) {
		if (message.length == 26 + i + +message.substr(26, i)) {
			return message.substr(26 + i);
		}
	}
	throw 'Invalid message - invalid security prefix';
};

export function cleanup (value, type = 'bytes32', api = parity.api) {
	// TODO: make work with arbitrary depth arrays
	if (value instanceof Array && type.match(/bytes[0-9]+/)) {
		// figure out if it's an ASCII string hiding in there:
		var ascii = '';
		for (var i = 0, ended = false; i < value.length && ascii !== null; ++i) {
			if (value[i] === 0) {
				ended = true;
			} else {
				ascii += String.fromCharCode(value[i]);
			}
			if ((ended && value[i] !== 0) || (!ended && (value[i] < 32 || value[i] >= 128))) {
				ascii = null;
			}
		}
		value = ascii === null ? '0x' + value.map(n => ('0' + n.toString(16)).slice(-2)).join('') : ascii;
	}
	if (type.substr(0, 4) == 'uint' && +type.substr(4) <= 48) {
		value = +value;
	}
	return value;
}
