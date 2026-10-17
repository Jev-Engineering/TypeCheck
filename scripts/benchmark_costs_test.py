import pathlib
import runpy
import unittest

cost_summary = runpy.run_path(str(pathlib.Path(__file__).with_name('summarize-kaggle-benchmark.py')))['cost_summary']
RATE = {'currency': 'USD', 'model': 'jev-1.14.0', 'perMillion': '0.042'}


def attempt(id, tokens, **completion):
    return [{'event': 'reserved', 'id': id, 'kind': 'text', 'model': RATE['model']},
            {'event': 'completed', 'id': id, 'inputTokens': tokens, **completion}]


class BenchmarkCostsTest(unittest.TestCase):
    def test_list_price_backfill_and_duplicate_receipts(self):
        events = attempt('a', 1000000) + attempt('b', 1000000)
        events += [events[1]]
        cost = cost_summary(events, RATE, RATE['model'])
        self.assertEqual(cost['estimatedAmount'], '0.084000')
        self.assertEqual(cost['pricedAttempts'], 2)
        self.assertEqual(cost['retrospectivelyPricedAttempts'], 2)
        self.assertFalse(cost['partial'])

    def test_round_each_attempt_before_sum(self):
        cost = cost_summary(attempt('a', 12) + attempt('retry', 12), RATE, RATE['model'])
        self.assertEqual(cost['costMicros'], '2')

    def test_missing_usage_and_pending_are_partial(self):
        events = attempt('known', 0) + attempt('unknown', None) + [{'event': 'reserved', 'id': 'pending'}]
        cost = cost_summary(events, RATE, RATE['model'])
        self.assertEqual(cost['pricedAttempts'], 1)
        self.assertEqual(cost['unknownUsageAttempts'], 1)
        self.assertEqual(cost['pendingAttempts'], 1)
        self.assertTrue(cost['partial'])

    def test_existing_estimates_are_preserved(self):
        events = attempt('priced', 1000000, costMicros='100000')
        events[0]['pricing'] = {**RATE, 'perMillion': '0.1'}
        cost = cost_summary(events, RATE, RATE['model'])
        self.assertEqual(cost['estimatedAmount'], '0.100000')
        self.assertEqual(cost['retrospectivelyPricedAttempts'], 0)

    def test_model_mismatch_fails(self):
        with self.assertRaises(ValueError):
            cost_summary(attempt('a', 100), RATE, 'other-model')


if __name__ == '__main__':
    unittest.main()
