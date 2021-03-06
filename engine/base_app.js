// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

const events = require('events');
const lang = require('lang');
const Q = require('q');

const Tier = require('./tier_manager').Tier;

module.exports = new lang.Class({
    Name: 'BaseApp',
    Abstract: true,
    Extends: events.EventEmitter,

    _init: function(engine, state) {
        // EventEmitter is a node.js class not a lang class,
        // can't chain up normally
        events.EventEmitter.call(this);

        this._engine = engine;
        this.isRunning = false;
        this._isSupported = undefined;

        // Set this to anything but undefined and your app will
        // be accessible to other apps using 'engine.apps.getSharedApp()
        this.sharedId = undefined;

        this.state = state;
        this.name = state.name;
    },

    serialize: function(state) {
        if (!this.state)
            throw new Error('Application lost state, cannot serialize');
        this.state.uniqueId = this.uniqueId;
        return this.state;
    },

    get engine() {
        return this._engine;
    },

    get isSupported() {
        if (this._isSupported !== undefined)
            return this._isSupported;

        this._isSupported = this.requiredCapabilities.every(function(cap) {
            return platform.hasCapability(cap);
        });
        return this._isSupported;
    },

    // default implementation runs on all tiers
    // you should rarely need to override this, require a specific capability
    // instead
    get allowedTiers() {
        return [Tier.PHONE, Tier.SERVER, Tier.CLOUD];
    },

    // default implementation requires no capabilities
    get requiredCapabilities() {
        return [];
    },

    start: function() {
        throw new Error('Not implemented');
    },

    stop: function() {
        throw new Error('Not implemented');
    },

    showUI: function(command) {
        // default app does not have any ui
        return ('<!DOCTYPE html><title>ThingEngine</title>'
                +'<p>Not available.</p>');
    },

    postUI: function(command) {
        // default app does not have any ui command
        return ('<!DOCTYPE html><title>ThingEngine</title>'
                +'<p>Not found.</p>');
    },
});


