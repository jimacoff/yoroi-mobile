// @flow

import {StyleSheet} from 'react-native'

import {COLORS} from '../../../styles/config'

export default StyleSheet.create({
  safeAreaView: {
    backgroundColor: COLORS.WHITE,
    flex: 1,
  },
  root: {
    flex: 1,
  },
  container: {
    backgroundColor: COLORS.WHITE,
    flex: 1,
    padding: 16,
  },
  transactionSummary: {
    flexDirection: 'row',
  },
  heading: {
    marginTop: 16,
  },
  actions: {
    padding: 16,
  },
  input: {
    marginTop: 16,
  },
  instructionsBlock: {
    marginVertical: 24,
  },
  paragraphText: {
    fontSize: 14,
    lineHeight: 22,
  },
  item: {
    marginTop: 12,
    fontSize: 14,
    lineHeight: 22,
  },
})
