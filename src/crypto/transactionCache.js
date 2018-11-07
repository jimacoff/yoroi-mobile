// @flow
import moment from 'moment'
import {defaultMemoize} from 'reselect'
import _ from 'lodash'
import assert from '../utils/assert'
import BigNumber from 'bignumber.js'

import {ObjectValues} from '../utils/flow'
import {limitConcurrency} from '../utils/promise'
import {Logger} from '../utils/logging'
import api from '../api'
import {CONFIG} from '../config'

import type {Moment} from 'moment'
import type {Dict} from '../state'
import type {Transaction} from '../types/HistoryTransaction'
import {TRANSACTION_STATUS} from '../types/HistoryTransaction'

type SyncMetadata = {
  lastUpdated: Moment,
  bestBlockNum: number,
}

type TransactionCacheState = {
  transactions: Dict<Transaction>,
  perAddressSyncMetadata: Dict<SyncMetadata>,
}

const transactionToJSON = (transaction: Transaction) => ({
  id: transaction.id,
  status: transaction.status,
  inputs: transaction.inputs.map(({address, amount}) => ({
    address,
    amount: amount.toString(),
  })),
  outputs: transaction.inputs.map(({address, amount}) => ({
    address,
    amount: amount.toString(),
  })),
  blockNum: transaction.blockNum,
  bestBlockNum: transaction.bestBlockNum,
  submittedAt: transaction.submittedAt.toISOString(),
  lastUpdatedAt: transaction.lastUpdatedAt.toISOString(),
})

const transactionFromJSON = (transaction: any): Transaction => ({
  id: transaction.id,
  status: transaction.status,
  inputs: transaction.inputs.map(({address, amount}) => ({
    address,
    amount: new BigNumber(amount, 10),
  })),
  outputs: transaction.inputs.map(({address, amount}) => ({
    address,
    amount: new BigNumber(amount, 10),
  })),
  blockNum: transaction.blockNum,
  bestBlockNum: transaction.bestBlockNum,
  submittedAt: moment(transaction.submittedAt),
  lastUpdatedAt: moment(transaction.lastUpdatedAt),
})

const syncMetadataToJSON = (meta: SyncMetadata) => ({
  lastUpdated: meta.lastUpdated.toISOString(),
  bestBlockNum: meta.bestBlockNum,
})

const syncMetadataFromJSON = (meta: any): SyncMetadata => ({
  lastUpdated: moment(meta.lastUpdated),
  bestBlockNum: meta.bestBlockNum,
})

const getLastTimestamp = (history: Array<Transaction>): ?Moment => {
  // Note(ppershing): ISO8601 dates can be sorted as strings
  // and the result is expected
  return _.max(history.map((tx) => tx.lastUpdatedAt), moment(0))
}

const perAddressTxsSelector = (state: TransactionCacheState) => {
  const transactions = state.transactions
  const addressToTxs = {}
  const addTxTo = (txId, addr) => {
    const current = addressToTxs[addr] || []
    const cleared = current.filter((_txId) => txId !== _txId)
    addressToTxs[addr] = [...cleared, txId]
  }

  ObjectValues(transactions).forEach((tx) => {
    tx.inputs.forEach(({address}) => {
      addTxTo(tx.id, address)
    })
    tx.outputs.forEach(({address}) => {
      addTxTo(tx.id, address)
    })
  })
  return addressToTxs
}

const confirmationCountsSelector = (state: TransactionCacheState) => {
  const {perAddressSyncMetadata, transactions} = state
  return _.mapValues(transactions, (tx: Transaction) => {
    if (tx.status !== TRANSACTION_STATUS.SUCCESSFUL) {
      // TODO(ppershing): do failed transactions have assurance?
      return null
    }

    const getBlockNum = ({address}) =>
      perAddressSyncMetadata[address]
        ? perAddressSyncMetadata[address].bestBlockNum
        : 0

    const bestBlockNum = _.max([
      tx.bestBlockNum,
      ...tx.inputs.map(getBlockNum),
      ...tx.outputs.map(getBlockNum),
    ])

    assert.assert(tx.blockNum, 'Successfull tx should have blockNum')
    /* :: if (!tx.blockNum) throw 'assert' */
    return bestBlockNum - tx.blockNum
  })
}

export class TransactionCache {
  _state: TransactionCacheState = {
    perAddressSyncMetadata: {},
    transactions: {},
  }

  _subscriptions: Array<() => any> = []
  _perAddressTxsSelector = defaultMemoize(perAddressTxsSelector)
  _confirmationCountsSelector = defaultMemoize(confirmationCountsSelector)

  subscribe(handler: () => any) {
    this._subscriptions.push(handler)
  }

  /* global $Shape */
  updateState(update: $Shape<TransactionCacheState>) {
    Logger.debug('TransactionHistory update state')
    Logger.debug('Update', update)

    this._state = {
      ...this._state,
      ...update,
    }

    this._subscriptions.forEach((handler) => handler())
  }

  get transactions() {
    return this._state.transactions
  }

  get perAddressTxs() {
    return this._perAddressTxsSelector(this._state)
  }

  get confirmationCounts() {
    return this._confirmationCountsSelector(this._state)
  }

  _getBlockMetadata(addrs: Array<string>) {
    assert.assert(addrs.length, 'getBlockMetadata: addrs not empty')
    const metadata = addrs.map(
      (addr) => this._state.perAddressSyncMetadata[addr],
    )

    const first = metadata[0]

    if (!first) {
      // New addresses
      assert.assert(
        metadata.every((x) => !x),
        'getBlockMetadata: undefined vs defined',
      )
      return {
        lastUpdated: moment(0),
        bestBlockNum: 0,
      }
    } else {
      // Old addresses
      assert.assert(
        metadata.every((x) => x.lastUpdated.isSame(first.lastUpdated)),
        'getBlockMetadata: lastUpdated metadata same',
      )
      assert.assert(
        metadata.every((x) => x.bestBlockNum === first.bestBlockNum),
        'getBlockMetadata: bestBlockNum metadata same',
      )

      return first
    }
  }

  _isUpdatedTransaction(tx: Transaction): boolean {
    const id = tx.id
    // We have this transaction and it did not change
    if (
      this._state.transactions[id] &&
      this._state.transactions[id].lastUpdatedAt.isSame(tx.lastUpdatedAt)
    ) {
      return false
    }
    if (this._state.transactions[id]) {
      // Do things that matter if the transaction changed!
      Logger.info('Tx changed', tx)
    }
    return true
  }

  // Returns number of updated transactions
  _checkUpdatedTransactions(transactions: Array<Transaction>): number {
    Logger.debug('_updateTransactions', transactions)
    // Currently we do not support two updates inside a same batch
    // (and backend shouldn't support it either)
    assert.assert(
      transactions.length === _.uniq(transactions.map((tx) => tx.id)).length,
      'Got the same transaction twice in one batch',
    )
    const updated = transactions.map((tx) => this._isUpdatedTransaction(tx))
    return _.sum(updated, (x) => (x ? 1 : 0))
  }

  async doSyncStep(blocks: Array<Array<string>>): Promise<boolean> {
    Logger.info('doSyncStep', blocks)
    let count = 0
    let wasPaginated = false
    const errors = []

    const tasks = blocks.map((addrs) => {
      const metadata = this._getBlockMetadata(addrs)
      return () =>
        api
          .fetchNewTxHistory(metadata.lastUpdated, addrs)
          .then((response) => [addrs, response])
    })

    const limit = limitConcurrency(CONFIG.MAX_CONCURRENT_REQUESTS)

    const promises = tasks.map((t) => limit(t))

    // Note(ppershing): This serializes the respons order
    // but still allows for concurrent requests
    for (const promise of promises) {
      try {
        const [addrs, response] = await promise
        wasPaginated = wasPaginated || !response.isLast
        const metadata = this._getBlockMetadata(addrs)
        const newLastUpdated = getLastTimestamp(response.transactions)
        // Note: we can update best block number only if we are processing
        // the last page of the history request, see design doc for details
        const newBestBlockNum =
          response.isLast && response.transactions.length
            ? response.transactions[0].bestBlockNum
            : metadata.bestBlockNum

        const newMetadata = {
          lastUpdated: newLastUpdated,
          bestBlockNum: newBestBlockNum,
        }

        const transactionsUpdate = _.fromPairs(
          response.transactions.map((tx) => [tx.id, tx]),
        )
        const metadataUpdate = _.fromPairs(
          addrs.map((addr) => [addr, newMetadata]),
        )

        count += this._checkUpdatedTransactions(response.transactions)

        this.updateState({
          transactions: {...this._state.transactions, ...transactionsUpdate},
          perAddressSyncMetadata: {
            ...this._state.perAddressSyncMetadata,
            ...metadataUpdate,
          },
        })
      } catch (e) {
        errors.push(e)
      }
    }

    if (errors.length) throw errors
    return wasPaginated || count > 0
  }

  toJSON() {
    return {
      transactions: _.mapValues(this._state.transactions, transactionToJSON),
      perAddressSyncMetadata: _.mapValues(
        this._state.perAddressSyncMetadata,
        syncMetadataToJSON,
      ),
    }
  }

  static fromJSON(data: any) {
    const cache = new TransactionCache()
    const parsed = {
      transactions: _.mapValues(data.transactions, transactionFromJSON),
      perAddressSyncMetadata: _.mapValues(
        data.perAddressSyncMetadata,
        syncMetadataFromJSON,
      ),
    }
    cache.updateState(parsed)
    return cache
  }
}