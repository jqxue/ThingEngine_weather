// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

const Q = require('q');
const events = require('events');
const http = require('http');
const lang = require('lang');
const net = require('net');
const WebSocket = require('ws');

const JsonDatagramSocket = require('./json_datagram_socket');
const Tier = require('./tier_manager').Tier;

//    phone <-> server, from the POV of a phone
// or phone <-> cloud, from the POV of the phone
// or server <-> cloud, from the POV of the server
// web sockets, client side
const ClientConnection = new lang.Class({
    Name: 'ClientConnection',
    Extends: events.EventEmitter,

    _init: function(serverAddress, identity, authToken) {
        events.EventEmitter.call(this);
        this._serverAddress = serverAddress;
        this._identity = identity;
        this._authToken = authToken;
        this._closeOk = false;

        this._outgoingBuffer = [];
        this._ratelimitTimer = null;
        this._retryAttempts = 3;
    },

    _onConnectionLost: function() {
        if (this._closeOk)
            return;

        console.log('Lost connection to the server');
        this._socket = null;

        // if the connection lasted less than 60 seconds, consider it
        // a failed open (subject to retry limit), otherwise reopen
        // right away

        var now = new Date;
        var retry;
        if (now.getTime() - this._ratelimitTimer.getTime() < 60000) {
            if (this._retryAttempts > 0) {
                retry = true;
            } else {
                retry = false;
            }
        } else {
            retry = true;
            console.log('Resetting retry limit');
            this._retryAttempts = 3;
        }

        if (retry) {
            this.open().catch(function(error) {
                this.emit('failed', this._outgoingBuffer);
            }.bind(this));
        } else {
            this.emit('failed', this._outgoingBuffer);
        }
    },

    _onConnected: function(socket) {
        this._socket = socket;

        console.log('Successfully connected to server');

        if (this._authToken !== undefined) {
            socket.send(JSON.stringify({control:'auth',
                                        identity: this._identity,
                                        token: this._authToken}));
        }

        this._outgoingBuffer.forEach(function(msg) {
            if (msg.control === undefined)
                msg.control = 'data';
            socket.send(msg);
        });
        this._outgoingBuffer = [];

        this._ratelimitTimer = new Date;

        this._socket.on('close', function() {
            if (socket != this._socket)
                return;

            this._onConnectionLost();
        }.bind(this));
        this._socket.on('message', function(data) {
            if (socket != this._socket)
                return;

            var msg;
            try {
                msg = JSON.parse(data);
            } catch(e) {
                console.error('Error parsing server message: ' + e);
                return;
            }

            // The control messages we expect to receive
            if (['auth-token-ok', 'data', 'close'].indexOf(msg.control) < 0) {
                console.error('Invalid control message ' + msg.control);
                // ignore the message, don't die (back/forward compatibility)
                return;
            }

            if (msg.control === 'close') {
                console.log('Server requested connection shutdown');
                this.close();
                this.emit('failed', this._outgoingBuffer);
                return;
            }

            if (msg.control === 'data')
                delete msg.control;

            this.emit('message', msg);
        }.bind(this));

        return Q(true);
    },

    open: function() {
        this._retryAttempts--;
        console.log('Attempting connection to the server, try ' + (3 - this._retryAttempts) + ' of 3');
        return Q.Promise(function(callback, errback) {
            try {
                var socket = new WebSocket(this._serverAddress);
                socket.on('open', function() {
                    callback(socket);
                });
                socket.on('error', function(error) {
                    errback(error);
                });
            } catch(e) {
                errback(e);
            }
        }.bind(this))
            .timeout(10000, 'Timed out')
            .then(function(socket) {
                return this._onConnected(socket);
            }.bind(this))
            .catch(function(error) {
                console.error('Failed to connect to server: ' + error);
                if (this._retryAttempts > 0) {
                    return this.open();
                } else {
                    this.emit('failed', this._outgoingBuffer);
                    return Q(false);
                }
            }.bind(this));
    },

    close: function() {
        this._socket.close();
        this._closeOk = true;
        this._socket = null;
        return Q();
    },

    send: function(msg) {
        if (this._socket) {
            if (msg.control === undefined)
                msg.control = 'data';
            this._socket.send(JSON.stringify(msg));
        } else {
            this._outgoingBuffer.push(msg);
        }
    },

    sendMany: function(buffer) {
        buffer.forEach(function(msg) { this.send(msg) }.bind(this));
    },
});

//    phone <-> server, from the POV of a server
// or phone <-> cloud, from the POV of the cloud
// or server <-> cloud, from the POV of the cloud
// on server: websockets endpoint, plugging in the express frontend
// on cloud: websockets server on Unix domain socket (proxied from frontend)
const ServerConnection = new lang.Class({
    Name: 'ServerConnection',
    Extends: events.EventEmitter,

    _init: function(authToken, expected) {
        events.EventEmitter.call(this);

        this._authToken = authToken;
        this._connections = {};
        this._wsServer = null;

        expected.forEach(function(from) {
            this._connections[from] = { socket: null, dataOk: false, closeOk: false,
                                        closeCallback: null, outgoingBuffer: [] };
        }.bind(this));
    },

    _findConnection: function(socket) {
        for (var id in this._connections) {
            if (this._connections[id].socket === socket)
                return this._connections[id];
        }
    },

    _handleConnection: function(socket) {
        var connection = {
            socket: socket,
            // wait for authentication
            dataOk: false,
            closeOk: false,
            closeCallback: null,
            outgoingBuffer: [],
        };

        console.log('New connection from client');

        socket.on('message', function(data) {
            var msg;
            try {
                msg = JSON.parse(data);
            } catch(e) {
                console.error('Error parsing client message: ' + e);
                return;
            }

            if (!connection.dataOk) {
                if (this._authToken === undefined) {
                    // initial setup mode
                    if (msg.control !== 'set-auth-token' || !msg.token) {
                        console.error('Invalid initial setup message');
                        socket.terminate();
                        return;
                    }

                    this._authToken = String(msg.token);
                    platform.getSharedPreferences().set('auth-token', this._authToken);
                    console.log('Received auth token from client');
                    socket.send(JSON.stringify({control:'auth-token-ok'}));
                    connection.socket = null;
                    connection.closeOk = true;
                    connection.dataOk = false;
                    connection.closeCallback = null;
                } else {
                    if (msg.control !== 'auth' || typeof msg.identity != 'string' ||
                        msg.token !== this._authToken) {
                        console.error('Invalid authentication message');
                        socket.terminate();
                    } else {
                        console.log('Client successfully authenticated');
                        connection.dataOk = true;

                        connection.identity = msg.identity;
                        var oldConnection = this._connections[connection.identity];
                        if (oldConnection && oldConnection.socket)
                            oldConnection.socket.terminate();
                        this._connections[connection.identity] = connection;

                        if (oldConnection.outgoingBuffer)
                            this.sendMany(oldConnection.outgoingBuffer, connection.identity);
                    }
                }
                return;
            } else {
                if (this._findConnection(socket) === undefined) // robustness
                    return;

                if (msg.control !== 'data') {
                    console.error('Invalid control message ' + msg.control);
                    // ignore the message, don't die (back/forward compatibility)
                    return;
                }

                delete msg.control;
            }

            this.emit('message', msg);
        }.bind(this));

        socket.on('close', function() {
            var connection = this._findConnection(socket);
            if (connection === undefined)
                return;

            if (connection.closeOk) {
                if (connection.closeCallback)
                    connection.closeCallback();
                return;
            }

            console.error('Lost connection from client with identity ' + connection.identity);

            connection.socket = null;
            connection.closeOk = false;
            connection.dataOk = false;
        }.bind(this));
    },

    open: function() {
        if (platform.type === 'server') {
            console.log('Adding express handler for websocket...');
            platform._getPrivateFeature('frontend-express').ws('/websocket', this._handleConnection.bind(this));
            return Q();
        } else if (platform.type === 'cloud') {
            this._wsServer = new WebSocket.Server({ noServer: true, disableHixie: true });
            process.on('message', function(message, socket) {
                if (message.type !== 'websocket')
                    return;

                var encodedReq = message.request;
                var req = JSON.parse((new Buffer(encodedReq, 'base64')).toString());
                req.socket = socket;
                req.connection = socket;
                this._wsServer.handleUpgrade(req, socket,
                                             new Buffer(message.upgradeHead, 'base64'),
                                             this._handleConnection.bind(this));
            }.bind(this));
            console.log('Added process message handler from monitor');
            return Q();
        }
    },

    close: function() {
        var promises = [];
        for (var id in this._connections) {
            var connection = this._connections[id];

            var p = Q.Promise(function(callback, errback) {
                if (connection.socket !== null) {
                    connection.socket.send(JSON.stringify({control:'close'}));
                    connection.closeOk = true;
                    connection.closeCallback = callback;
                } else {
                    connection.closeOk = false;
                    connection.closeCallback = null;
                    callback();
                }
            }).timeout(10000, 'ETIMEOUT').catch(function(e) {
                if (e.message != 'ETIMEOUT')
                    throw e;

                // the phone failed to close the connection within 10 seconds,
                // tear down the connection forcibly (this will cause a RST on
                // the wire)
                if (connection.socket) // robustness
                    connection.socket.terminate();
            });
            promises.push(p);
        }
        return Q.all(promises).then(function() {
            if (this._wsServer)
                this._wsServer.close();
            this._wsServer = null;
        }.bind(this));
    },

    _sendTo: function(msg, to) {
        var connection = this._connections[to];
        if (connection === undefined)
            throw new Error('Invalid destination for server message');

        if (connection.socket && connection.dataOk) {
            if (msg.control === undefined)
                msg.control = 'data';
            connection.socket.send(JSON.stringify(msg));
        } else {
            connection.outgoingBuffer.push(msg);
        }
    },

    send: function(msg, to) {
        if (to !== undefined) {
            this._sendTo(msg, to);
            return;
        }

        for (var id in this._connections)
            this._sendTo(msg, id);
    },

    sendMany: function(buffer, to) {
        buffer.forEach(function(msg) { this.send(msg, to) }.bind(this));
    },
});

module.exports = {
    ClientConnection: ClientConnection,
    ServerConnection: ServerConnection
};
