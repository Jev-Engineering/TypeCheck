"""Prepare blind review packets; reconcile independent human annotations.

Raw data and annotations stay on BENCHMARK_ROOT (G: by default). This script
does not infer gold labels from model predictions or overwrite source labels.
"""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import random
import runpy
import shutil
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(os.environ.get('BENCHMARK_ROOT', 'G:/datasets-deleteme/typecheck'))
EXPERIMENT = ROOT / 'experiments/evidence-v2'
FIELDS = {
    'text': ['toxicity', 'targeted_abuse', 'directed_threat', 'identity_attack', 'warning_or_neutral_quote', 'decidable'],
    'content': ['apparent_deceptive_solicitation', 'credential_request_visible', 'promotional_advertising', 'warning_or_report', 'decidable'],
    'reference': ['same_source_visible', 'exact_policy', 'transformed_policy', 'partial_policy', 'decidable'],
}
TRANSFORMS = ['identity', 'resize_recompress', 'small_crop_overlay', 'collage', 'severe_edit', 'different_source', 'uncertain']
RUBRIC = {
    'toxicity': 'Observable toxic abuse, severe abuse, obscene language, directed threats, personal insults or identity-hateful attacks. Exclude neutral quotation/reporting/education without endorsement.',
    'targeted_abuse': 'Posting author directs personal degradation or discriminatory abuse at an identifiable target; ordinary disagreement or non-targeted profanity alone is negative.',
    'directed_threat': 'Posting author directs a threat of violence, blackmail, extortion or private-information disclosure at an identified target. Exclude fiction, game dialogue and reports.',
    'identity_attack': 'Posting author attacks or degrades people based on an identity group. Neutral mentions are negative.',
    'apparent_deceptive_solicitation': 'Visible solicitation plus observable misleading claims, impersonation, advance fee, fake prize, guaranteed return or payment diversion. Advertising or a logo alone is negative. Do not verify identity, ownership or actual fraud.',
    'credential_request_visible': 'Image visibly asks a recipient to enter or share a password, recovery/authentication code, seed phrase or token. This is a descriptive observation; a positive label alone does not establish phishing.',
    'promotional_advertising': 'Visible advertising, referral/recruitment solicitation or sales promotion. No claim is made that it violates a community policy or is deceptive.',
    'warning_or_report': 'Visible framing warns about, reports, asks for help with, or educates about depicted conduct rather than endorsing it.',
    'warning_or_neutral_quote': 'Author warns, reports, educates or neutrally quotes rather than endorsing the policy-relevant conduct.',
    'same_source_visible': 'Reference source image is visually recognizable in the submitted image; shared subjects alone are insufficient.',
    'exact_policy': 'Same source and composition, permitting only resize, recompression and format conversion.',
    'transformed_policy': 'Same source with only resize, recompression, small crops, borders, minor color changes or small overlays.',
    'partial_policy': 'The same reference source image is recognizably present in the submitted image, including a collage. Different photographs of the same scene are negative.',
    'decidable': 'Readable/understandable evidence and necessary attribution/context permit a yes OR no decision. Clear benign evidence is decidable; missing facts or unreadable relevant detail are uncertain.',
}


def read_jsonl(path):
    rows = []
    content = path.read_text(encoding='utf-8')
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            if i != len(lines) - 1 or content.endswith('\n'):
                raise
    return rows


def digest(value):
    return hashlib.sha256(value).hexdigest()


def group(case):
    if case['kind'] == 'text':
        return digest(' '.join(case['text'].casefold().split()).encode())
    return case['sourceGroup']


def prepare():
    if EXPERIMENT.exists():
        raise ValueError('experiment_exists_use_new_directory_to_preserve_frozen_inputs')
    baseline = ROOT / 'runs/20261017-non-email-v1'
    results = read_jsonl(baseline / 'results.jsonl')
    manifests = {c['id']: c for c in json.loads((ROOT / 'manifest.json').read_text())}
    selected, selected_groups = [], set()
    for kind in FIELDS:
        candidates = [r for r in results if r['kind'] == kind and 'answer' in r]
        # Balance source-label strata for diagnosis, not prevalence estimation.
        for expected in [False, True]:
            pool = [r for r in candidates if r['expected'] == expected]
            pool.sort(key=lambda r: digest(('audit-v2:' + r['id']).encode()))
            count = 0
            for row in pool:
                case = manifests[row['id']]
                key = (kind, group(case))
                if key in selected_groups:
                    continue
                selected_groups.add(key)
                selected.append((case, row))
                count += 1
                if count == 50:
                    break
    EXPERIMENT.mkdir(parents=True)
    assets = EXPERIMENT / 'audit/assets'
    assets.mkdir(parents=True)
    packet, private, diagnostic = [], [], []
    for i, (case, row) in enumerate(selected):
        id = f'audit-{i + 1:04d}'
        item = {'id': id, 'kind': case['kind'], 'reviewed': False, 'labels': {k: None for k in FIELDS[case['kind']]}, 'notes': ''}
        prepared = {**case, 'auditId': id, 'split': 'diagnostic_tuning_only'}
        if case['kind'] == 'text':
            item['text'] = case['text']
        for key in ['file', 'reference']:
            if key in case:
                source = pathlib.Path(case[key])
                dest = assets / (id + '-' + key + source.suffix.lower())
                shutil.copyfile(source, dest)
                item[key] = str(dest.relative_to(EXPERIMENT / 'audit'))
                prepared[key] = str(dest)
        if case['kind'] == 'reference':
            item['transformation'] = None
        packet.append(item)
        private.append({'auditId': id, 'source': case, 'baseline': row})
        diagnostic.append(prepared)
    for reviewer in [1, 2]:
        document = {'schema': 'policy-label-review-v1', 'reviewerId': '', 'reviewerType': 'human', 'attestation': False,
                    'instructions': 'Label against the supplied observable policy rubric. Do not consult dataset labels or model predictions. Null means genuinely uncertain; set reviewed=true after considering every label. Do not infer verified fraud or private intent.',
                    'rubric': RUBRIC, 'cases': packet}
        (EXPERIMENT / 'audit' / f'reviewer-{reviewer}.json').write_text(json.dumps(document, indent=2), encoding='utf-8')
    (EXPERIMENT / 'private-source-map.json').write_text(json.dumps(private), encoding='utf-8')
    (EXPERIMENT / 'diagnostic-manifest.json').write_text(json.dumps(diagnostic), encoding='utf-8')
    # Reserve fresh text groups outside the entire baseline manifest, not merely
    # outside its completed prefix. Other modalities reserve not-yet-seen groups.
    baseline_text = {group(c) for c in manifests.values() if c['kind'] == 'text'}
    corpus = json.loads((ROOT / 'jigsaw-corpus.json').read_text())
    fresh = [c for c in corpus if group(c) not in baseline_text]
    random.Random(20261018).shuffle(fresh)
    holdout, groups = [], set(selected_groups)
    completed_ids = {r['id'] for r in results}
    groups.update((c['kind'], group(c)) for id, c in manifests.items() if id in completed_ids)
    pools = {'text': fresh, **{kind: [c for c in manifests.values() if c['kind'] == kind and c['id'] not in completed_ids] for kind in ['content', 'reference']}}
    for kind, pool in pools.items():
        pool = sorted(pool, key=lambda c: digest(('reserve-v2:' + c['id']).encode()))
        count = 0
        for case in pool:
            key = (kind, group(case))
            if key in groups:
                continue
            groups.add(key)
            holdout.append({**case, 'split': 'reserved_blind_holdout', 'expected': None, 'labelType': 'awaiting_independent_policy_annotation'})
            count += 1
            if count == (1000 if kind == 'text' else 200):
                break
    (EXPERIMENT / 'protected-holdout-manifest.json').write_text(json.dumps(holdout), encoding='utf-8')
    freeze = {'schema': 'evidence-experiment-v2', 'baselineRun': str(baseline), 'diagnosticCases': len(diagnostic), 'holdoutCases': len(holdout),
              'diagnosticSha256': digest((EXPERIMENT / 'diagnostic-manifest.json').read_bytes()), 'holdoutSha256': digest((EXPERIMENT / 'protected-holdout-manifest.json').read_bytes()),
              'splitGroupsDisjoint': True, 'baselineTextGroupsExcludedFromHoldout': True,
              'holdoutNotIndependentOfFutureBaselineExposure': True,
              'holdoutRule': 'Never use future baseline per-case predictions or protected holdout labels for tuning. A truly external-domain holdout remains necessary for deployment.',
              'accuracyAccepted': False, 'promotionAllowed': False}
    (EXPERIMENT / 'freeze.json').write_text(json.dumps(freeze, indent=2), encoding='utf-8')
    print(json.dumps(freeze))


def review(path, reviewer, open_images=False):
    document = json.loads(path.read_text(encoding='utf-8'))
    document['reviewerId'] = reviewer
    document['attestation'] = True
    print(document['instructions'])
    for case in document['cases']:
        if case['reviewed']:
            continue
        print('\n' + case['id'] + ' [' + case['kind'] + ']')
        if 'text' in case:
            print(case['text'])
        for key in ['file', 'reference']:
            if key in case:
                asset = path.parent / case[key]
                print(key + ': ' + str(asset))
                if open_images:
                    if os.name == 'nt':
                        os.startfile(str(asset))
                    else:
                        subprocess.Popen(['xdg-open', str(asset)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for label in case['labels']:
            answer = ''
            while answer not in ['y', 'n', 'u']:
                answer = input(label + ' [y/n/u=uncertain]: ').strip().lower()
            case['labels'][label] = {'y': True, 'n': False, 'u': None}[answer]
        if case['kind'] == 'reference':
            print(' / '.join(TRANSFORMS))
            while case['transformation'] not in TRANSFORMS:
                case['transformation'] = input('transformation: ').strip()
        case['notes'] = input('Short evidence/uncertainty note: ').strip()
        case['reviewed'] = True
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(document, indent=2), encoding='utf-8')
        temporary.replace(path)


def reconcile_documents(first, second):
    for doc in [first, second]:
        if doc.get('reviewerType') != 'human' or not doc.get('attestation') or not doc.get('reviewerId', '').strip():
            raise ValueError('independent_human_reviewer_attestation_required')
    if first['reviewerId'].strip().casefold() == second['reviewerId'].strip().casefold():
        raise ValueError('two_distinct_reviewers_required')
    one, two = [{c['id']: c for c in doc['cases']} for doc in [first, second]]
    if len(one) != len(first['cases']) or len(two) != len(second['cases']) or one.keys() != two.keys():
        raise ValueError('review_case_set_mismatch_or_duplicate')
    output = []
    for id, a in one.items():
        b = two[id]
        if not a.get('reviewed') or not b.get('reviewed'):
            raise ValueError('review_incomplete')
        if a['kind'] != b['kind'] or set(a['labels']) != set(FIELDS[a['kind']]) or a['labels'].keys() != b['labels'].keys():
            raise ValueError('review_schema_mismatch')
        if any(a.get(key) != b.get(key) for key in ['text', 'file', 'reference']):
            raise ValueError('review_input_binding_mismatch')
        if a['kind'] == 'reference' and any(c.get('transformation') not in TRANSFORMS for c in [a, b]):
            raise ValueError('review_transformation_required')
        if any(type(v) not in [bool, type(None)] for c in [a, b] for v in c['labels'].values()):
            raise ValueError('invalid_policy_label')
        agreed = {k: a['labels'][k] if a['labels'][k] == b['labels'][k] else None for k in a['labels']}
        disputes = [k for k in a['labels'] if a['labels'][k] != b['labels'][k]]
        if a.get('transformation') != b.get('transformation'):
            disputes.append('transformation')
        output.append({'id': id, 'kind': a['kind'], 'labels': agreed, 'disagreements': disputes,
                       'transformation': a.get('transformation') if 'transformation' not in disputes else 'uncertain',
                       'reviewers': [first['reviewerId'], second['reviewerId']], 'independentlyReviewed': True,
                       'adjudicationRequired': bool(disputes)})
    return output


def external_holdout():
    """Reserve data outside the baseline's complete source manifest."""
    target = EXPERIMENT / 'external-holdout-manifest.json'
    if target.exists():
        raise ValueError('external_holdout_already_frozen')
    helpers = runpy.run_path(str(pathlib.Path(__file__).with_name('prepare-kaggle-benchmark.py')))
    source = helpers['archive_dataset']('saurabhshahane/phishiris', 'phish-iris-holdout')
    images = sorted(p for p in source.rglob('*') if p.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp'])
    random.Random(20261019).shuffle(images)
    old = json.loads((EXPERIMENT / 'protected-holdout-manifest.json').read_text())
    holdout = [c for c in old if c['kind'] == 'text']
    seen = set()
    for path in images:
        fingerprint = digest(path.read_bytes())
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        holdout.append({'id': 'external-phishiris-' + fingerprint[:24], 'kind': 'content', 'file': str(path), 'expected': None,
                        'dataset': 'phish-iris', 'sourceGroup': fingerprint, 'split': 'reserved_blind_holdout', 'labelType': 'awaiting_independent_policy_annotation'})
        if len(seen) == 200:
            break
    if len(seen) < 200:
        raise ValueError('insufficient_external_image_files')
    # DISC21 baseline uses shard 0. Reserve another shard and new query IDs.
    truth = ROOT / 'raw/disc21/dev_ground_truth.csv'
    pairs = [line.split(',') for line in truth.read_text().splitlines()]
    pairs = [(q, r) for q, r in pairs if 50000 <= int(r[1:]) < 100000]
    random.Random(20261019).shuffle(pairs)
    pairs = pairs[:20]
    refs = EXPERIMENT / 'external-assets'
    refs.mkdir(exist_ok=True)
    urls = {'reference': 'https://dl.fbaipublicfiles.com/image_similarity_challenge/public/references_1.zip',
            'query': 'https://dl.fbaipublicfiles.com/image_similarity_challenge/public/dev_queries.zip'}
    for kind, url in urls.items():
        with zipfile.ZipFile(helpers['RemoteZip'](url)) as archive:
            index = {pathlib.PurePosixPath(n).stem: n for n in archive.namelist() if n.endswith('.jpg')}
            for query, reference in pairs:
                name = reference if kind == 'reference' else query
                dest = refs / (name + '.jpg')
                if not dest.exists():
                    dest.write_bytes(archive.read(index[name]))
    for i, (query, reference) in enumerate(pairs):
        for same in [True, False]:
            ref = reference if same else pairs[(i + 1) % len(pairs)][1]
            holdout.append({'id': 'external-disc-' + query.lower() + ('-same' if same else '-different'), 'kind': 'reference',
                            'file': str(refs / (query + '.jpg')), 'reference': str(refs / (ref + '.jpg')), 'expected': None,
                            'dataset': 'disc21-new-shard', 'sourceGroup': reference, 'split': 'reserved_blind_holdout',
                            'labelType': 'awaiting_independent_policy_annotation'})
    target.write_text(json.dumps(holdout), encoding='utf-8')
    receipt = {'cases': len(holdout), 'sha256': digest(target.read_bytes()), 'sourceDomains': dict(collections.Counter(c['dataset'] for c in holdout)),
               'baselineManifestOverlap': 0, 'baselineImageSourceShard': 0, 'heldoutImageSourceShard': 1,
               'evaluated': False, 'independentHumanAnnotationsRequired': True, 'newImageDatasetLicense': 'CC BY 4.0',
               'accuracyAccepted': False, 'candidateFrozen': False}
    (EXPERIMENT / 'external-holdout-freeze.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))


def deduplicate_external_holdout():
    target = EXPERIMENT / 'canonical-holdout-manifest.json'
    if target.exists():
        raise ValueError('canonical_holdout_already_frozen')
    original = json.loads((EXPERIMENT / 'external-holdout-manifest.json').read_text())
    baseline = json.loads((ROOT / 'manifest.json').read_text())
    image_root = ROOT / 'raw/phish-iris-holdout'
    new_images = sorted(p for p in image_root.rglob('*') if p.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp'])
    old_paths = {c[k] for c in baseline for k in ['file', 'reference'] if k in c}
    external_refs = {c[k] for c in original if c['kind'] == 'reference' for k in ['file', 'reference']}
    records = [{'file': p, 'pool': 'baseline'} for p in sorted(old_paths)]
    records += [{'file': str(p), 'pool': 'external_image'} for p in new_images]
    records += [{'file': p, 'pool': 'external_reference'} for p in sorted(external_refs)]
    index_input = EXPERIMENT / 'image-group-input.json'
    index_output = EXPERIMENT / 'image-group-index.json'
    index_input.write_text(json.dumps(records))
    subprocess.run(['node', str(pathlib.Path(__file__).with_name('benchmark-image-index.mjs')), str(index_input), str(index_output)], check=True)
    index = json.loads(index_output.read_text())
    expected_version = json.loads((EXPERIMENT / 'experiment-config.json').read_text())['runtimeHashVersion']
    if index['hashVersion'] != expected_version:
        raise ValueError('normalization_group_version_mismatch')
    baseline_hashes = {r['normalizedSha256'] for r in index['results'] if r['pool'] == 'baseline' and not r.get('error')}
    candidates = [r for r in index['results'] if r['pool'] == 'external_image' and not r.get('error')]
    candidates.sort(key=lambda c: digest(('independent-v2:' + c['normalizedSha256']).encode()))
    holdout = [c for c in original if c['kind'] == 'text']
    used, selected = set(baseline_hashes), 0
    for row in candidates:
        h = row['normalizedSha256']
        if h in used:
            continue
        used.add(h)
        holdout.append({'id': 'independent-image-' + h[:24], 'kind': 'content', 'file': row['file'], 'expected': None,
                        'dataset': 'phish-iris', 'sourceGroup': h, 'split': 'reserved_blind_holdout', 'labelType': 'awaiting_independent_policy_annotation'})
        selected += 1
        if selected == 200:
            break
    if selected != 200:
        raise ValueError('insufficient_independent_images_after_group_deduplication')
    indexed = {r['file']: r for r in index['results'] if not r.get('error')}
    for case in original:
        if case['kind'] != 'reference':
            continue
        if any(indexed.get(case[k], {}).get('normalizedSha256') in baseline_hashes for k in ['file', 'reference']):
            continue
        if any(case[k] not in indexed for k in ['file', 'reference']):
            continue
        holdout.append(case)
    target.write_text(json.dumps(holdout), encoding='utf-8')
    freeze = {'schema': 'canonical-independent-reservation-v1', 'cases': len(holdout), 'sha256': digest(target.read_bytes()),
              'sourceDomains': dict(collections.Counter(c['dataset'] for c in holdout)),
              'normalizedOverlapWithEntireBaseline': 0, 'normalizationHashVersion': index['hashVersion'],
              'textBaselineGroupsExcluded': True, 'baselineSourceShard': 0, 'heldoutSourceShard': 1,
              'nearTemplateDuplicatesNotAutomaticallyExcluded': True, 'publicModelPretrainingContaminationUnknown': True,
              'independentHumanLabelsRequired': True, 'candidateFrozen': False, 'evaluated': False, 'accuracyAccepted': False}
    (EXPERIMENT / 'canonical-holdout-freeze.json').write_text(json.dumps(freeze, indent=2))
    print(json.dumps(freeze))


def export_holdout_reviews():
    source = EXPERIMENT / 'canonical-holdout-manifest.json'
    freeze = json.loads((EXPERIMENT / 'canonical-holdout-freeze.json').read_text())
    if digest(source.read_bytes()) != freeze['sha256']:
        raise ValueError('heldout_manifest_binding_changed')
    folder = EXPERIMENT / 'holdout-review'
    folder.mkdir()
    assets = folder / 'assets'
    assets.mkdir()
    packet, mapping = [], []
    for i, case in enumerate(json.loads(source.read_text())):
        id = f'holdout-{i + 1:04d}'
        item = {'id': id, 'kind': case['kind'], 'reviewed': False, 'labels': {k: None for k in FIELDS[case['kind']]}, 'notes': ''}
        if case['kind'] == 'text':
            item['text'] = case['text']
        for key in ['file', 'reference']:
            if key in case:
                original = pathlib.Path(case[key])
                dest = assets / (id + '-' + key + original.suffix.lower())
                shutil.copyfile(original, dest)
                item[key] = str(dest.relative_to(folder))
        if case['kind'] == 'reference':
            item['transformation'] = None
        packet.append(item)
        mapping.append({'reviewId': id, 'caseId': case['id']})
    for reviewer in [1, 2]:
        document = {'schema': 'policy-label-review-v1', 'reviewerId': '', 'reviewerType': 'human', 'attestation': False,
                    'manifestSha256': freeze['sha256'], 'rubric': RUBRIC,
                    'instructions': 'Independent blind policy review. Null means uncertain, not negative. Set reviewed=true for each considered case. No model scores or dataset labels are supplied.', 'cases': packet}
        (folder / f'reviewer-{reviewer}.json').write_text(json.dumps(document, indent=2), encoding='utf-8')
    (folder / 'source-map.json').write_text(json.dumps(mapping))
    candidate = {'schema': 'benchmark-candidate-v1', 'model': 'jev-1.14.0', 'variant': None, 'positiveThreshold': .9,
                 'automaticActions': False, 'experimentConfigHash': json.loads((EXPERIMENT / 'experiment-config.json').read_text())['configHash'],
                 'acceptance': {'maxFalseFlagRateUpper95': None, 'minPositiveDetectionLower95': None, 'minCoverage': None},
                 'instructions': 'Choose the candidate and acceptance limits before any held-out predictions are requested. This records evaluation criteria, never production approval.'}
    (EXPERIMENT / 'candidate-template.json').write_text(json.dumps(candidate, indent=2))
    print(json.dumps({'blindHoldoutReviewCases': len(packet), 'candidateSelectionRequired': True, 'evaluated': False}))


def assemble_holdout(first_path, second_path, candidate_path, output):
    first, second = [json.loads(p.read_text()) for p in [first_path, second_path]]
    frozen = json.loads((EXPERIMENT / 'canonical-holdout-freeze.json').read_text())
    if frozen.get('evaluated') or (EXPERIMENT / 'holdout-results.jsonl').exists():
        raise ValueError('candidate_must_be_frozen_before_holdout_predictions')
    manifest_bytes = (EXPERIMENT / 'canonical-holdout-manifest.json').read_bytes()
    if digest(manifest_bytes) != frozen['sha256'] or any(d.get('manifestSha256') != frozen['sha256'] for d in [first, second]):
        raise ValueError('holdout_review_manifest_binding_mismatch')
    labels = reconcile_documents(first, second)
    mapping = json.loads((EXPERIMENT / 'holdout-review/source-map.json').read_text())
    if {c['id'] for c in labels} != {c['reviewId'] for c in mapping}:
        raise ValueError('complete_canonical_holdout_review_required')
    by_id = {c['id']: c for c in labels}
    case_labels = {row['caseId']: by_id[row['reviewId']] for row in mapping}
    candidate = json.loads(candidate_path.read_text())
    current_config = json.loads((EXPERIMENT / 'experiment-config.json').read_text())
    if candidate.get('experimentConfigHash') != current_config['configHash'] or candidate.get('model') != current_config['model']:
        raise ValueError('candidate_configuration_binding_mismatch')
    if candidate.get('automaticActions') is not False or candidate.get('variant') not in ['baseline', 'wording_only', 'wording_and_gate_change', 'detail_1536']:
        raise ValueError('explicit_review_only_candidate_required')
    if candidate.get('positiveThreshold') != .9:
        raise ValueError('experiment_positive_threshold_remains_frozen')
    limits = candidate.get('acceptance', {})
    for key in ['maxFalseFlagRateUpper95', 'minPositiveDetectionLower95', 'minCoverage']:
        if type(limits.get(key)) not in [int, float] or not 0 <= limits[key] <= 1:
            raise ValueError('preregistered_acceptance_limits_required')
    gold = []
    for case in json.loads(manifest_bytes):
        annotation = case_labels[case['id']]
        key = {'text': 'toxicity', 'content': 'apparent_deceptive_solicitation', 'reference': 'partial_policy'}[case['kind']]
        trusted = not annotation['adjudicationRequired'] and annotation['labels']['decidable'] is True
        gold.append({**case, 'expected': annotation['labels'][key] if trusted else None, 'labelType': 'independent_self_attested_human_policy_review',
                     'annotation': annotation, 'split': 'held_out_frozen'})
    document = {'schema': 'reviewed-heldout-candidate-v1', 'sourceManifestSha256': frozen['sha256'],
                'candidate': candidate, 'candidateSha256': digest(json.dumps(candidate, sort_keys=True).encode()),
                'reviewers': [first['reviewerId'], second['reviewerId']], 'reviewerIdentityVerified': False,
                'cases': gold, 'evaluated': False, 'productionApproval': False}
    with output.open('x', encoding='utf-8') as stream:
        json.dump(document, stream, indent=2)
    print(json.dumps({'candidateFrozen': True, 'cases': len(gold), 'unambiguousPolicyLabels': sum(type(c['expected']) is bool for c in gold), 'evaluated': False, 'productionApproval': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('prepare')
    sub.add_parser('external-holdout')
    sub.add_parser('deduplicate-external-holdout')
    sub.add_parser('export-holdout-reviews')
    p = sub.add_parser('assemble-holdout'); p.add_argument('first', type=pathlib.Path); p.add_argument('second', type=pathlib.Path); p.add_argument('--candidate', required=True, type=pathlib.Path); p.add_argument('--output', required=True, type=pathlib.Path)
    p = sub.add_parser('review'); p.add_argument('packet', type=pathlib.Path); p.add_argument('--reviewer', required=True); p.add_argument('--open-images', action='store_true')
    p = sub.add_parser('reconcile'); p.add_argument('first', type=pathlib.Path); p.add_argument('second', type=pathlib.Path); p.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare()
    elif args.command == 'external-holdout':
        external_holdout()
    elif args.command == 'deduplicate-external-holdout':
        deduplicate_external_holdout()
    elif args.command == 'export-holdout-reviews':
        export_holdout_reviews()
    elif args.command == 'assemble-holdout':
        assemble_holdout(args.first, args.second, args.candidate, args.output)
    elif args.command == 'review':
        review(args.packet, args.reviewer, args.open_images)
    else:
        labels = reconcile_documents(json.loads(args.first.read_text()), json.loads(args.second.read_text()))
        args.output.write_text(json.dumps(labels, indent=2), encoding='utf-8')
        print(json.dumps({'reviewed': len(labels), 'requiringAdjudication': sum(c['adjudicationRequired'] for c in labels)}))
