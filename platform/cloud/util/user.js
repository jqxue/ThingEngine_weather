// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

const Q = require('q');
const crypto = require('crypto');
const model = require('../model/user');

function requireLogin(res) {
    res.render('login_required', { page_title: "ThingEngine - Login required" });
}

function loggedIn(req, userId) {
    req.session.user_id = userId;
}

function makeRandom() {
    return crypto.randomBytes(32).toString('hex');
}

function hashPassword(salt, password) {
    var hash = crypto.createHash('sha256');
    hash.update('$' + salt + '$' + password + '$');
    return hash.digest('hex');
}

module.exports = {
    withLogin: function(req, res, dbClient, handler) {
        var user_id = req.session.user_id;

        if (user_id === undefined)
            return requireLogin(res);
        else
            return model.get(dbClient, user_id)
            .then(handler)
            .catch(function(error) {
                requireLogin(res);
            });
    },

    loggedIn: loggedIn,
    isLoggedIn: function(req) {
        return req.session.user_id !== undefined;
    },

    register: function(req, res, dbClient, username, password) {
        return model.getByName(dbClient, username).then(function(rows) {
            if (rows.length > 0)
                throw new Error("An user with this name already exists");

            var salt = makeRandom();
            var cloudId = makeRandom();
            var authToken = makeRandom();
            return model.create(dbClient, username, salt, hashPassword(salt, password), cloudId, authToken)
                .then(function(userId) {
                    loggedIn(req, userId);
                    return [userId, cloudId, authToken];
                });
        });
    },

    login: function(req, res, dbClient, username, password) {
        return model.getByName(dbClient, username).then(function(rows) {
            if (rows.length < 1)
                throw new Error("An user with this username does not exist");

            if (hashPassword(rows[0].salt, password) !== rows[0].password)
                throw new Error("Invalid username or password");

            loggedIn(req, rows[0].id);
            return rows[0];
        });
    },

    logout: function(req) {
        delete req.session.user_id;
    }
};
