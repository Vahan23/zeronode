/**
 * Created by avar and dave on 2/14/17.
 */
import _ from 'underscore';
import  Promise from 'bluebird';
import md5 from 'md5';
import animal from 'animal-id';
import { EventEmitter } from 'events';
import { RequestWatcher, TickWatcher} from './sockets';

import Server from './server';
import Client from './client';
import Errors from './errors';
import Metric from './metric';
import Globals from './globals';
import { events } from './enum';
import {Enum as socketEvents} from './sockets';
import winston from 'winston';

const _private = new WeakMap();

let defaultLogger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({level: 'error'}),
    ]
});

export default class Node extends EventEmitter {
    constructor(data = {}) {
        super();

        let {id, bind, options, logger} = data;
        options = options || {};
        id = id || _generateNodeId();
        logger = logger || defaultLogger

        this.logger = logger;

        let _scope = {
            id,
            bind,
            options,
            metric: {
                status: false,
                info: new Metric({id}),
                interval: null
            },
            nodeServer : null,
            nodeClients : new Map(),
            nodeClientsAddressIndex : new Map(),
            tickWatcherMap: new Map(),
            requestWatcherMap: new Map()
        };

        this::initNodeServer();

        _private.set(this, _scope)
    }

    getId() {
        let {id} = _private.get(this);
        return id;
    }

    getAddress() {
        let {nodeServer} = _private.get(this);
        return nodeServer ? nodeServer.getAddress() : null;
    }

    getOptions() {
        let {options} = _private.get(this);
        return options;
    }

    getFilteredNodes({filter = {}, down = true, up = true} = {filter: {}, down: true, up: true}){
        let _scope = _private.get(this);
        let nodes = new Set();

        function checkNode (node) {
            let options = node.getOptions();
            let notSatisfying = !!_.find(filter, (filterValue, filterKey) => {
                if (filterValue instanceof RegExp && typeof options[filterKey] == 'string') {
                    return !filterValue.test(options[filterKey])
                } else if (!(filterValue instanceof RegExp)) {
                    return !(filterValue == options[filterKey])
                }
                return true
            });
            if (!notSatisfying) {
                nodes.add(node.id)
            }
        }
        if(_scope.nodeServer && down) {
            _scope.nodeServer.getOnlineClients().forEach(checkNode, this)
        }

        if(_scope.nodeClients.size && up) {
            _scope.nodeClients.forEach((client) => {
                let actorModel = client.getServerActor();
                if(actorModel && actorModel.isOnline()) {
                    checkNode(actorModel)
                }
            }, this)
        }
        return Array.from(nodes);
    }

    setAddress(bind) {
        let {nodeServer} = _private.get(this);
        nodeServer ? nodeServer.setAddress(bind) : this.logger.info('No server available');
    }

    async bind(routerAddress) {
        let {nodeServer} = _private.get(this);
        return await nodeServer.bind(routerAddress);
    }

    unbind() {
        let {nodeServer} = _private.get(this);
        if(!nodeServer) return true;

        nodeServer.unbind();
        return true;
    }

    // ** connect returns the id of the connected node
    async connect(address = 'tcp://127.0.0.1:3000', timeout) {
        if (typeof address != 'string' || address.length == 0) {
            throw new Error(`Wrong type for argument address ${address}`)
        }

        let _scope = _private.get(this);
        let {id, options, metric, nodeClientsAddressIndex, nodeClients} = _scope;
        let metricEnabled = metric.status;
        let metricInfo = metric.info;

        let addressHash = md5(address);

        if (nodeClientsAddressIndex.has(addressHash)) {
            return nodeClientsAddressIndex.get(addressHash);
        }

        let client = new Client({ id, options, logger: this.logger });

        if (metricEnabled) {
            client.setMetric(true);
        }

        client.on(events.SERVER_FAILURE, this::_serverFailureHandler);

        client.on('error', (err) => {
            this.emit('error', err)
        });

        client.on(socketEvents.SEND_TICK, () => {
            if (metricEnabled) {
                metricInfo.sendTick(client.getServerActor().getId());
            }
        });

        client.on(socketEvents.GOT_TICK, () => {
            if (metricEnabled) {
                metricInfo.gotTick(client.getServerActor().getId())
            }
        });

        client.on(socketEvents.SEND_REQUEST, (id) => {
            if (metricEnabled) {
                metricInfo.sendRequest(id)
            }
        });

        client.on(socketEvents.GOT_REQUEST, () => {
            if (metricEnabled) {
                metricInfo.gotRequest(client.getServerActor().getId());
            }
        });

        client.on(socketEvents.REQUEST_TIMEOUT, () => {
            if (metricEnabled) {
                metricInfo.requestTimeout(client.getServerActor().getId());
            }
        });

        client.on(socketEvents.GOT_REPLY, ({id, sendTime, getTime, replyTime, replyGetTime}) => {
            if (metricEnabled) {
                metricInfo.gotReply({id, sendTime, getTime, replyTime, replyGetTime});
            }
        });

        client.on(events.SERVER_STOP, (serverActor) => {
            this.emit(events.SERVER_STOP, serverActor.toJSON())
        });

        let { actorId, options } = await client.connect(address, timeout);

        this.logger.info(`Node connected: ${this.getId()} -> ${actorId}`);

        nodeClientsAddressIndex.set(addressHash, actorId);
        nodeClients.set(actorId, client);

        this::_addExistingListenersToClient(client);

        return {
            actorId,
            options
        };
    }

    // TODO::avar maybe disconnect from node ?
    async disconnect(address = 'tcp://127.0.0.1:3000') {
        if (typeof address != 'string' || address.length == 0) {
            throw new Error(`Wrong type for argument address ${address}`);
        }

        let addressHash = md5(address);

        let _scope = _private.get(this);
        let {nodeClientsAddressIndex, nodeClients} = _scope;


        if(!nodeClientsAddressIndex.has(addressHash)) return true;

        let nodeId = nodeClientsAddressIndex.get(addressHash);
        let client = nodeClients.get(nodeId);

        client.removeAllListeners(events.SERVER_FAILURE);
        client.removeAllListeners(socketEvents.SEND_TICK);
        client.removeAllListeners(socketEvents.GOT_TICK);
        client.removeAllListeners(socketEvents.SEND_REQUEST);
        client.removeAllListeners(socketEvents.GOT_REQUEST);
        client.removeAllListeners(socketEvents.GOT_REPLY);

        await client.disconnect();
        this::_removeClientAllListeners(client);
        nodeClients.delete(nodeId);
        nodeClientsAddressIndex.delete(addressHash);
        return true;
    }

    async stop() {
        let {nodeServer, nodeClients} = _private.get(this);
        let stopPromise = [];
        if(nodeServer.isOnline()) {
            nodeServer.unbind();
        }

        nodeClients.forEach((client)=>{
            if(client.isOnline()) {
                stopPromise.push(client.disconnect());
            }
        }, this);

        await Promise.all(stopPromise);
    }

    onRequest(endpoint, fn) {
        let _scope = _private.get(this);
        let {requestWatcherMap, nodeClients, nodeServer} = _scope;

        let requestWatcher = requestWatcherMap.get(endpoint);
        if(!requestWatcher) {
            requestWatcher = new RequestWatcher(endpoint);
            requestWatcherMap.set(endpoint, requestWatcher)
        }

        requestWatcher.addRequestListener(fn);

        nodeServer.onRequest(endpoint, fn);

        nodeClients.forEach((client) => {
            client.onRequest(endpoint, fn)
        }, this);
    }

    offRequest(endpoint, fn) {
        let _scope = _private.get(this);

        _scope.nodeServer.offRequest(endpoint);
        _scope.nodeClients.forEach((client)=>{
            client.offRequest(endpoint, fn)
        });

        let requestWatcher = _scope.requestWatcherMap.get(endpoint);
        if(requestWatcher) {
            requestWatcher.removeRequestListener(fn)
        }
    }

    onTick(event, fn) {
        let _scope = _private.get(this);
        let {tickWatcherMap, nodeClients, nodeServer} = _scope;

        let tickWatcher = tickWatcherMap.get(event);
        if(!tickWatcher) {
            tickWatcher = new TickWatcher(event);
            tickWatcherMap.set(event, tickWatcher)
        }

        tickWatcher.addTickListener(fn);

        // ** _scope.nodeServer is constructed in Node constructor
        nodeServer.onTick(event, fn);

        nodeClients.forEach((client) => {
            client.onTick(event, fn);
        });
    }

    offTick(event, fn) {
        let _scope = _private.get(this);
        _scope.nodeServer.offTick(event);
        _scope.nodeClients.forEach((client)=>{
            client.offTick(event, fn)
        }, this);

        let tickWatcher = _scope.tickWatcherMap.get(event);
        if(tickWatcher) {
            tickWatcher.removeTickListener(fn)
        }
    }

    async request(nodeId, endpoint, data, timeout = Globals.REQUEST_TIMEOUT) {
        let _scope = _private.get(this);
        let {nodeServer, nodeClients}  = _scope;

        let clientActor = this::_getClientByNode(nodeId);
        if(clientActor) {
            return nodeServer.request(clientActor.getId(), endpoint, data, timeout)
        }

        if(nodeClients.has(nodeId)) {
            // ** nodeId is the serverId of node so we request
            return nodeClients.get(nodeId).request(endpoint, data, timeout)
        }

        throw new Error(`Node with ${nodeId} is not found.`)
    }

    tick(nodeId, event, data) {
        let _scope = _private.get(this);
        let {nodeServer, nodeClients}  = _scope;
        let clientActor = this::_getClientByNode(nodeId);
        if(clientActor) {
            return nodeServer.tick(clientActor.getId(), event, data)
        }
        if(nodeClients.has(nodeId)) {
            return nodeClients.get(nodeId).tick(event, data)
        }
        throw new Error(`Node with ${nodeId} is not found.`);
    }

    async requestAny(endpoint, data, timeout = Globals.REQUEST_TIMEOUT, filter = {}, down, up) {
        let filteredNodes = this.getFilteredNodes({filter, down, up});
        if (!filteredNodes.length) {
            throw {code: Errors.NO_NODE , message: 'there is no node with that filter'}
        }
        let nodeId = this::_getWinnerNode(filteredNodes, endpoint);
        return this.request(nodeId, endpoint, data, timeout);
    }

    async requestDownAny(endpoint, data, timeout, filter) {
        return await this.requestAny(endpoint, data, timeout, filter, true, false);
    }

    async requestUpAny(endpoint, data, timeout, filter) {
        return await this.requestAny(endpoint, data, timeout, filter, false, true);
    }

    tickAny(event, data, filter = {}, down, up) {
        let filteredNodes = this.getFilteredNodes({filter, down, up});
        if (!filteredNodes.length) {
            throw {code: Errors.NO_NODE , message: 'there is no node with that filter'}
        }
        let nodeId = this::_getWinnerNode(filteredNodes, event);
        return this.tick(nodeId, event, data);
    }

    tickDownAny(event, data, filter) {
        return this.tickAny(event, data, filter, true, false)
    }

    tickUpAny(event, data, filter) {
        return this.tickAny(event, data, filter, false, true)
    }

    tickAll(event, data, filter = {}, down, up) {
        let filteredNodes = this.getFilteredNodes({filter, down, up});
        let tickPromises = [];

        filteredNodes.forEach((nodeId)=> {
            tickPromises.push(this.tick(nodeId, event, data));
        }, this);

        return Promise.all(tickPromises);
    }

    tickDownAll(event, data, filter) {
        return this.tickAll(event, data, filter, true, false)
    }

    tickUpAll(event, data, filter) {
        return this.tickAll(event, data, filter, false, true)
    }

    enableMetrics (interval = 1000) {
        let _scope = _private.get(this);
        let {metric, nodeClients, nodeServer} = _scope;
        metric.status = true;

        nodeClients.forEach((client) => {
            client.setMetric(true);
        }, this);

        nodeServer.setMetric(true);

        metric.interval = setInterval(() => {
            this.emit(events.METRICS, metric.info);
            metric.info.flush();
        }, interval)
    }

    disableMetrics () {
        let _scope = _private.get(this);
        let {metric, nodeClients, nodeServer} = _scope;
        metric.status = false;
        nodeClients.forEach((client) => {
            client.setMetric(false)
        }, this);
        nodeServer.setMetric(false,);
        clearInterval(metric.interval);
        metric.interval = null;
        metric.info.flush();
    }

    setLogLevel (level) {
        this.logger.transports.console.level = level;
    }

    addFileToLog (filename, level) {
        this.logger.add(winston.transports.File, {filename, level});
    }

    setOptions (options) {
        let _scope = _private.get(this);
        _scope.options = options;

        let {nodeServer, nodeClients} = _scope;
        nodeServer.setOptions(options);
        nodeClients.forEach((client) => {
            client.setOptions(options);
        }, this)
    }
}

// ** PRIVATE FUNCTIONS

function initNodeServer() {
    let _scope = _private.get(this);
    let {id, bind, options, metric} = _scope;
    let metricsEnabled = metric.status;
    let metricsInfo = metric.info;

    let nodeServer = new Server({id, bind, logger: this.logger, options});
    // ** handlers for nodeServer
    nodeServer.on('error', (err) => {
        this.emit('error', err);
    });

    nodeServer.on(socketEvents.SEND_TICK, (id) => {
        if (metricsEnabled) {
            metricsInfo.sendTick(id);
        }
    });

    nodeServer.on(socketEvents.GOT_TICK, (id) => {
        if (metricsEnabled) {
            metricsInfo.gotTick(id)
        }
    });

    nodeServer.on(socketEvents.SEND_REQUEST, (id) => {
        if (metricsEnabled) {
            metricsInfo.sendRequest(id)
        }
    });

    nodeServer.on(socketEvents.GOT_REQUEST, (id) => {
        if (metricsEnabled) {
            metricsInfo.gotRequest(id)
        }
    });

    nodeServer.on(socketEvents.REQUEST_TIMEOUT, (id) => {
        if (metricsEnabled) {
            metricsInfo.requestTimeout(id)
        }
    });

    nodeServer.on(socketEvents.GOT_REPLY, ({id, sendTime, getTime, replyTime, replyGetTime}) => {
        if (metricsEnabled) {
            metricsInfo.gotReply({id, sendTime, getTime, replyTime, replyGetTime})
        }
    });

    nodeServer.on(events.CLIENT_FAILURE, this::_clientFailureHandler);
    nodeServer.on(events.CLIENT_CONNECTED, this::_clientConnectHandler);
    nodeServer.on(events.CLIENT_STOP, this::_clientStopHandler);
    _scope.nodeServer = nodeServer;
}

function _getClientByNode(nodeId) {
    let _scope = _private.get(this);
    let actors = _scope.nodeServer.getOnlineClients().filter((actor) => {
        let node =  actor.getId();
        return node == nodeId;
    });

    if(!actors.length) {
        return null;
    }

    if(actors.length > 1) {
        return this.logger('warn', `We should have just 1 client from 1 node`);
    }

    return actors[0];
}

function _generateNodeId() {
    return animal.getId()
}

function _getWinnerNode(nodeIds, tag) {
    let len = nodeIds.length;
    let idx = Math.floor(Math.random() * len);
    return nodeIds[idx];
}

function _addExistingListenersToClient(client) {
    let _scope = _private.get(this);

    // ** adding previously added onTick-s for this client to
    _scope.tickWatcherMap.forEach((tickWatcher, event) => {
        // ** TODO what about order of functions ?
        tickWatcher.getFnSet().forEach((fn) => {
            client.onTick(event, this::fn);
        }, this);
    }, this);

    // ** adding previously added onRequests-s for this client to
    _scope.requestWatcherMap.forEach((requestWatcher, endpoint) => {
        // ** TODO what about order of functions ?
        requestWatcher.getFnSet().forEach((fn) => {
            client.onRequest(endpoint, this::fn);
        }, this);
    }, this);
}

function _removeClientAllListeners(client) {
    let _scope = _private.get(this);

    // ** adding previously added onTick-s for this client to
    _scope.tickWatcherMap.forEach((tickWatcher, event) => {
        client.offTick(event, this::fn);
    }, this);

    // ** adding previously added onRequests-s for this client to
    _scope.requestWatcherMap.forEach((requestWatcher, endpoint) => {
        client.offRequest(endpoint);
    }, this);
}

function _clientFailureHandler(clientActor) {
    this.emit(events.CLIENT_FAILURE, clientActor.toJSON())
}

function _serverFailureHandler(serverActor) {
    this.emit(events.SERVER_FAILURE, serverActor.toJSON())
}

function _clientConnectHandler(clientActor) {
    this.emit(events.CLIENT_CONNECTED, clientActor.toJSON())
}

function _clientStopHandler(clientActor) {
    this.emit(events.CLIENT_STOP, clientActor.toJSON())
}