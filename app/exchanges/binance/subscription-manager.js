"use strict";
const _ = require('lodash');
const debug = require('debug')('CEG:ExchangeSubscriptionManager:Binance');
const logger = require('winston');
const AbstractExchangeSubscriptionManagerClass = require('../../abstract-exchange-subscription-manager');
const StreamClientClass = require('./stream-client');

const BASE_WS_URI = 'wss://stream.binance.com:9443/ws';

class SubscriptionManager extends AbstractExchangeSubscriptionManagerClass
{

/**
 * Constructor
 *
 * @param {object} exchange exchange instance
 * @param {object} config full config object
 */
constructor(exchange)
{
    super(exchange, {globalTickersSubscription:false, marketsSubscription:false});
    // Binance WS only provides access to oder books update through WS, we need to use REST API to retrieve full order book
    this._waitingForFullOrderBooks = {};
    // keep track of last emitted cseq id for order books
    this._orderBooksUpdates = {};
    this._clients = {
        orderBooks:{},
        trades:{},
        klines:{},
        tickers:{}
    }
}

/**
 * Used to retrieve full order book and block order book updates until order book has been successfull retrieved
 *
 * @param {string} pair pair for which we want to block order book updates while we're retrieving order book
 */
_waitForFullOrderBook(pair)
{
    if (undefined === this._waitingForFullOrderBooks[pair])
    {
        this._waitingForFullOrderBooks[pair] = {requestId:0,fullOrderBookCseq:0};
    }
    let requestId = ++this._waitingForFullOrderBooks[pair].requestId;
    this._waitingForFullOrderBooks[pair].waiting = true;
    let self = this;
    this._exchangeInstance.getOrderBook(pair, {custom:{includeLastUpdateId:true}}).then(function(data){
        // we have another pending request
        if (requestId != self._waitingForFullOrderBooks[pair].requestId)
        {
            return;
        }
        // if we already emitted an orderBook event for same cseq, ignore event
        if (self._waitingForFullOrderBooks[pair].fullOrderBookCseq == data.lastUpdateId)
        {
            self._waitingForFullOrderBooks[pair].waiting = false;
            return;
        }
        // if we already emitted an orderBookUpdate event with an higher cseq, retrieve full order book again
        if (undefined !== self._orderBooksUpdates[pair] && data.lastUpdateId <= self._orderBooksUpdates[pair])
        {
            self._waitForFullOrderBook.call(self, pair);
            return;
        }
        let evt = {
            exchange:self._exchangeId,
            pair:pair,
            cseq:data.lastUpdateId,
            data:{
                buy:data.buy,
                sell:data.sell
            }
        }
        self._waitingForFullOrderBooks[pair].fullOrderBookCseq = data.lastUpdateId;
        self._waitingForFullOrderBooks[pair].waiting = false;
        self.emit('orderBook', evt);
    }).catch (function(err){
        logger.warn("Could not retrieve Binance order book for pair '%s' : err = '%s'", pair, err);
        // we have another pending request
        if (requestId != self._waitingForFullOrderBooks[pair].requestId)
        {
            return;
        }
        self._waitingForFullOrderBooks[pair].waiting = false;
    });
}

/**
 * Indicates whether or not we're waiting for full order book for a given pair
 *
 *  @param {string} pair pair to check
 *  @param {integer} updateCseq the cseq received in order book update
 *
 *  @return {boolean} true if we're waiting for full order book, false otherwise
 */
_waitingForFullOrderBook(pair, updateCseq)
{
    // not waiting for full order book
    if (undefined === this._waitingForFullOrderBooks[pair])
    {
        return false;
    }
    // order book not retrieve yet
    if (this._waitingForFullOrderBooks[pair].waiting)
    {
        return true;
    }
    // we're not interested in this update, it's too old
    if (updateCseq <= this._waitingForFullOrderBooks[pair].fullOrderBookCseq)
    {
        return true;
    }
    return false;
}

/**
 * @return {boolean} true if client was already connected, false otherwise
 */
_registerOrderBookClient(pair)
{
    let client = this._clients.orderBooks[pair];
    if (undefined !== client)
    {
        if (!client.isConnected() && !client.isConnecting())
        {
            client.connect();
            return false;
        }
        return true;
    }
    let p = this._exchangeInstance._toExchangePair(pair).toLowerCase();
    let uri = BASE_WS_URI + `/${p}@depth`;
    let self = this;
    client = new StreamClientClass(this._exchangeId, uri);
    let descriptor = {entity:'orderBook',pair:pair,client:client}
    client.on('connected', function(){
        self._registerConnection(`orderBook-${pair}`, {uri:uri});
        // everytime client is reconnected, we need to wait for full order book
        self._waitForFullOrderBook.call(self, pair);
        self._processSubscriptions.call(self, descriptor);
    });
    client.on('disconnected', function(){
        self._unregisterConnection(`orderBook-${pair}`);
        // nothing to do, reconnection will be automatic
    });
    // no more retry left, we need to reconnect
    client.on('terminated', function(){
        self._unregisterConnection(`orderBook-${pair}`);
        client.reconnect(false);
    });
    client.on('orderBookUpdate', function(evt){
        // ignore if we don't support this pair
        if (undefined === self._subscriptions.orderBooks.pairs[evt.pair])
        {
            return;
        }
        // ignore if we're waiting for full order book
        if (self._waitingForFullOrderBook.call(self, evt.pair, evt.cseq))
        {
            return;
        }
        // save last cseq
        self._orderBooksUpdates[evt.pair] = evt.cseq;
        evt.exchange = self._exchangeId;
        self.emit('orderBookUpdate', evt);
    });
    this._clients.orderBooks[pair] = client;
    client.connect();
    return false;
}

_unregisterOrderBookClient(pair)
{
    if (undefined === this._clients.orderBooks[pair])
    {
        return;
    }
    this._unregisterConnection(`orderBook-${pair}`);
    this._clients.orderBooks[pair].disconnect();
}

/**
 * @return {boolean} true if client was already connected, false otherwise
 */
_registerTickerClient(pair)
{
    let client = this._clients.tickers[pair];
    if (undefined !== client)
    {
        if (!client.isConnected() && !client.isConnecting())
        {
            client.connect();
            return false;
        }
        return true;
    }
    let p = this._exchangeInstance._toExchangePair(pair).toLowerCase();
    let uri = BASE_WS_URI + `/${p}@ticker`;
    let self = this;
    client = new StreamClientClass(this._exchangeId, uri);
    let descriptor = {entity:'ticker',pair:pair,client:client}
    client.on('connected', function(){
        self._registerConnection(`ticker-${pair}`, {uri:uri});
        self._processSubscriptions.call(self, descriptor);
    });
    client.on('disconnected', function(){
        self._unregisterConnection(`ticker-${pair}`);
        // nothing to do, reconnection will be automatic
    });
    // no more retry left, we need to reconnect
    client.on('terminated', function(){
        self._unregisterConnection(`ticker-${pair}`);
        client.reconnect(false);
    });
    client.on('ticker', function(evt){
        // ignore if we don't support this pair
        if (undefined === self._subscriptions.tickers.pairs[evt.pair])
        {
            return;
        }
        evt.exchange = self._exchangeId;
        self.emit('ticker', evt);
    });
    this._clients.tickers[pair] = client;
    client.connect();
    return false;
}

_unregisterTickerClient(pair)
{
    if (undefined === this._clients.tickers[pair])
    {
        return;
    }
    this._unregisterConnection(`ticker-${pair}`);
    this._clients.tickers[pair].disconnect();
}

_registerTradesClient(pair)
{
    let client = this._clients.trades[pair];
    if (undefined !== client)
    {
        if (!client.isConnected() && !client.isConnecting())
        {
            client.connect();
        }
        return;
    }
    let p = this._exchangeInstance._toExchangePair(pair).toLowerCase();
    let uri = BASE_WS_URI + `/${p}@aggTrade`;
    let self = this;
    client = new StreamClientClass(this._exchangeId, uri);
    let descriptor = {entity:'trades',pair:pair,client:client}
    client.on('connected', function(){
        self._registerConnection(`trades-${pair}`, {uri:uri});
        self._processSubscriptions.call(self, descriptor);
    });
    client.on('disconnected', function(){
        self._unregisterConnection(`trades-${pair}`);
        // nothing to do, reconnection will be automatic
    });
    // no more retry left, we need to reconnect
    client.on('terminated', function(){
        self._unregisterConnection(`trades-${pair}`);
        client.reconnect(false);
    });
    client.on('trades', function(evt){
        // ignore if we don't support this pair
        if (undefined === self._subscriptions.trades.pairs[evt.pair])
        {
            return;
        }
        evt.exchange = self._exchangeId;
        self.emit('trades', evt);
    });
    this._clients.trades[pair] = client;
    client.connect();
}

_unregisterTradesClient(pair)
{
    if (undefined === this._clients.trades[pair])
    {
        return;
    }
    this._unregisterConnection(`trades-${pair}`);
    this._clients.trades[pair].disconnect();
}

_registerKlinesClient(pair, interval)
{
    if (undefined === this._clients.klines[pair])
    {
        this._clients.klines[pair] = {};
    }
    let client = this._clients.klines[pair][interval];
    if (undefined !== client)
    {
        if (!client.isConnected() && !client.isConnecting())
        {
            client.connect();
        }
        return;
    }
    let p = this._exchangeInstance._toExchangePair(pair).toLowerCase();
    let uri = BASE_WS_URI + `/${p}@kline_${interval}`;
    let self = this;
    client = new StreamClientClass(this._exchangeId, uri);
    let descriptor = {entity:'klines',pair:pair,interval:interval,client:client}
    client.on('connected', function(){
        self._registerConnection(`klines-${pair}-${interval}`, {uri:uri});
        self._processSubscriptions.call(self, descriptor);
    });
    client.on('disconnected', function(){
        self._unregisterConnection(`klines-${pair}-${interval}`);
        // nothing to do, reconnection will be automatic
    });
    // no more retry left, we need to reconnect
    client.on('terminated', function(){
        self._unregisterConnection(`klines-${pair}-${interval}`);
        client.reconnect(false);
    });
    client.on('kline', function(evt){
        // ignore if we don't support this pair
        if (undefined === self._subscriptions.klines.pairs[evt.pair] || undefined === self._subscriptions.klines.pairs[evt.pair][evt.interval])
        {
            return;
        }
        evt.exchange = self._exchangeId;
        self.emit('kline', evt);
    });
    this._clients.klines[pair][interval] = client;
    client.connect();
}

_unregisterKlinesClient(pair, interval)
{
    if (undefined === this._clients.klines[pair] || undefined === this._clients.klines[pair][interval])
    {
        return;
    }
    this._unregisterConnection(`klines-${pair}-${interval}`);
    this._clients.klines[pair][interval].disconnect();
}

/**
 * Process subscription changes
 *
 * @param {object} changes list of changes to process
 * @param {boolean} opt.connect whether or not changes should trigger a connection
 * @param {object} opt.client {entity:string,pair:string,client:object} (optional, only useful if exchange requires multiple stream clients) (will only be set upon WS connection/reconnection)
 *
 *  Each property (subscribe,unsubscribe,resync) is optional
 *  Entity can be (ticker,tickers,orderBook,trades,market)
 *
 * {
 *    "subscribe":[{"entity":"","pair":""},...],
 *    "unsubscribe":[{"entity":"","pair":""},...],
 *    "resync":[{"entity":"","pair":""},...]
 * }
 */
_processChanges(changes, opt)
{
    // check if we need to unsubscribe
    if (undefined !== changes.unsubscribe)
    {
        _.forEach(changes.unsubscribe, (entry) => {
            switch (entry.entity)
            {
                case 'ticker':
                    this._unregisterTickerClient(entry.pair);
                    break;
                case 'orderBook':
                    this._unregisterOrderBookClient(entry.pair);
                    break;
                case 'trades':
                    this._unregisterTradesClient(entry.pair);
                    break;
                case 'klines':
                    this._unregisterKlinesClient(entry.pair, entry.interval);
                    break;
            }
        });
    }

    // check if we need to resync order books
    if (undefined !== changes.resync)
    {
        _.forEach(changes.resync, (entry) => {
            if (this._registerOrderBookClient(entry.pair))
            {
                this._waitForFullOrderBook(entry.pair);
            }
        });
    }

    // check if we need to subscribe
    if (undefined !== changes.subscribe)
    {
        // only if we'be been asked to connect to exchange streams
        if (opt.connect)
        {
            _.forEach(changes.subscribe, (entry) => {
                switch (entry.entity)
                {
                    case 'ticker':
                        this._registerTickerClient(entry.pair);
                        break;
                    case 'orderBook':
                        this._registerOrderBookClient(entry.pair);
                        break;
                    case 'trades':
                        this._registerTradesClient(entry.pair);
                        break;
                    case 'klines':
                        this._registerKlinesClient(entry.pair, entry.interval);
                        break;
                }
            });
        }
    }
}

}

module.exports = SubscriptionManager;
