import pathlib
import runpy
import json
import hashlib
import tempfile
import unittest

module = runpy.run_path(str(pathlib.Path(__file__).with_name('benchmark-label-audit.py')))
reconcile = module['reconcile_documents']
FIELDS = module['FIELDS']


def document(reviewer):
    return {'reviewerId': reviewer, 'reviewerType': 'human', 'attestation': True,
            'cases': [{'id': 'opaque', 'kind': 'text', 'text': 'Example', 'reviewed': True,
                       'labels': {key: True for key in FIELDS['text']}}]}


class LabelReviewTest(unittest.TestCase):
    def test_partial_live_receipt_tail_is_distinct_from_committed_corruption(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'rows.jsonl'
            path.write_text('{"id":1}\n{"unfinished":')
            self.assertEqual(module['read_jsonl'](path), [{'id': 1}])
            path.write_text('{"id":1}\n{"corrupt":\n')
            with self.assertRaises(json.JSONDecodeError):
                module['read_jsonl'](path)

    def test_distinct_human_reviewers_and_complete_cases_required(self):
        a, b = document('Alice'), document('Bob')
        self.assertTrue(reconcile(a, b)[0]['independentlyReviewed'])
        with self.assertRaisesRegex(ValueError, 'distinct'):
            reconcile(a, document('alice'))
        b['cases'][0]['reviewed'] = False
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            reconcile(a, b)

    def test_disagreement_never_becomes_automatic_gold(self):
        a, b = document('Alice'), document('Bob')
        b['cases'][0]['labels']['toxicity'] = False
        row = reconcile(a, b)[0]
        self.assertIsNone(row['labels']['toxicity'])
        self.assertTrue(row['adjudicationRequired'])

    def test_input_and_schema_binding(self):
        a, b = document('Alice'), document('Bob')
        b['cases'][0]['text'] = 'Changed'
        with self.assertRaisesRegex(ValueError, 'binding'):
            reconcile(a, b)
        b = document('Bob')
        del b['cases'][0]['labels']['decidable']
        with self.assertRaisesRegex(ValueError, 'schema'):
            reconcile(a, b)

    def test_missing_attestation_and_fabricated_label_types_rejected(self):
        a, b = document('Alice'), document('Bob')
        b['attestation'] = False
        with self.assertRaisesRegex(ValueError, 'attestation'):
            reconcile(a, b)
        b = document('Bob'); b['cases'][0]['labels']['toxicity'] = 'yes'
        with self.assertRaisesRegex(ValueError, 'invalid_policy_label'):
            reconcile(a, b)

    def test_holdout_requires_bound_reviews_and_preregistered_candidate(self):
        scratch = pathlib.Path('G:/datasets-deleteme/typecheck')
        with tempfile.TemporaryDirectory(dir=scratch if scratch.exists() else None) as folder:
            root = pathlib.Path(folder)
            (root / 'holdout-review').mkdir()
            manifest = json.dumps([{'id': 'source', 'kind': 'text', 'text': 'Example', 'expected': None}])
            sha = hashlib.sha256(manifest.encode()).hexdigest()
            (root / 'canonical-holdout-manifest.json').write_text(manifest)
            (root / 'canonical-holdout-freeze.json').write_text(json.dumps({'sha256': sha, 'evaluated': False}))
            (root / 'experiment-config.json').write_text(json.dumps({'configHash': 'frozen', 'model': 'jev-1.14.0'}))
            (root / 'holdout-review/source-map.json').write_text(json.dumps([{'reviewId': 'opaque', 'caseId': 'source'}]))
            for name, reviewer in [('a.json', 'Alice'), ('b.json', 'Bob')]:
                doc = document(reviewer); doc['manifestSha256'] = sha
                (root / name).write_text(json.dumps(doc))
            candidate = {'model': 'jev-1.14.0', 'experimentConfigHash': 'frozen', 'automaticActions': False, 'variant': 'wording_only', 'positiveThreshold': .9, 'acceptance': {'maxFalseFlagRateUpper95': None, 'minPositiveDetectionLower95': .5, 'minCoverage': .7}}
            (root / 'candidate.json').write_text(json.dumps(candidate))
            assemble = module['assemble_holdout']; previous = assemble.__globals__['EXPERIMENT']
            assemble.__globals__['EXPERIMENT'] = root
            try:
                args = [root / 'a.json', root / 'b.json', root / 'candidate.json', root / 'gold.json']
                with self.assertRaisesRegex(ValueError, 'acceptance_limits'):
                    assemble(*args)
                candidate['acceptance']['maxFalseFlagRateUpper95'] = .05
                (root / 'candidate.json').write_text(json.dumps(candidate))
                assemble(*args)
                result = json.loads((root / 'gold.json').read_text())
                self.assertFalse(result['productionApproval'])
                self.assertTrue(result['cases'][0]['expected'])
                (root / 'holdout-results.jsonl').write_text('{}\n')
                with self.assertRaisesRegex(ValueError, 'before_holdout'):
                    assemble(*args)
            finally:
                assemble.__globals__['EXPERIMENT'] = previous


if __name__ == '__main__':
    unittest.main()
