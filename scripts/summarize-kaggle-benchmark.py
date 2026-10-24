"""Read benchmark receipts without credentials; write an interim or final report."""
import collections
from decimal import Decimal
import hashlib
import json
import os
import pathlib
import statistics
import subprocess
import sys
import time

ROOT = pathlib.Path('G:/datasets-deleteme/typecheck')
RUN = ROOT / 'runs/20261017-non-email-v1'


def read_jsonl(path):
    rows = []
    lines = path.read_text(encoding='utf-8').splitlines()
    for i, line in enumerate(lines):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            if i != len(lines) - 1:
                raise
            # A live writer may not have finished its last line yet.
    return rows


def confusion(rows, primary=False):
    m = dict(tp=0, tn=0, fp=0, fn=0, abstained=0, errors=0, duplicates=0)
    for row in rows:
        if row.get('duplicate'):
            m['duplicates'] += 1
            continue
        if row.get('error'):
            m['errors'] += 1
            continue
        probability = row.get('answer', {}).get('probability')
        prediction = probability >= row['threshold'] if primary and probability is not None else row['predicted']
        if prediction is None:
            m['abstained'] += 1
        else:
            m['tp' if prediction and row['expected'] else 'fp' if prediction else 'fn' if row['expected'] else 'tn'] += 1
    decided = m['tp'] + m['tn'] + m['fp'] + m['fn']
    m['precision'] = m['tp'] / (m['tp'] + m['fp']) if m['tp'] + m['fp'] else None
    m['recall_on_decided_cases'] = m['tp'] / (m['tp'] + m['fn']) if m['tp'] + m['fn'] else None
    m['false_positive_rate_on_decided_negatives'] = m['fp'] / (m['fp'] + m['tn']) if m['fp'] + m['tn'] else None
    m['coverage'] = decided / (len(rows) - m['duplicates']) if len(rows) > m['duplicates'] else None
    m['all_positive_detection_rate'] = m['tp'] / sum(r['expected'] and not r.get('duplicate') for r in rows) if any(r['expected'] and not r.get('duplicate') for r in rows) else None
    return m


def cost_summary(events, pricing, model):
    """Use per-attempt integer rounding; retain unknown and pending coverage."""
    if pricing is None:
        return None
    if pricing['currency'] != 'USD' or pricing['model'] != model:
        raise ValueError('benchmark_pricing_model_or_currency_mismatch')
    reserved, completed = {}, {}
    for event in events:
        if event['event'] == 'reserved':
            reserved.setdefault(event['id'], event)
        elif event['event'] == 'completed':
            completed.setdefault(event['id'], event)
    micros, priced, retrospective, unknown, pending, tokens = 0, 0, 0, 0, 0, 0
    by_kind = collections.defaultdict(lambda: {'costMicros': 0, 'inputTokens': 0, 'pricedAttempts': 0})
    for id, reservation in reserved.items():
        if reservation.get('model', model) != model:
            raise ValueError('mixed_model_billing_requires_separate_rates')
        completion = completed.get(id)
        if completion is None:
            pending += 1
            continue
        usage = completion.get('inputTokens')
        if type(usage) is not int or usage < 0:
            unknown += 1
            continue
        rate = reservation.get('pricing') or pricing
        if rate['currency'] != pricing['currency'] or rate['model'] != model:
            raise ValueError('mixed_currency_or_model_in_attempt_pricing')
        price_micros = int(Decimal(rate['perMillion']) * 1000000)
        amount = int(completion['costMicros']) if completion.get('costMicros') is not None else (usage * price_micros + 500000) // 1000000
        micros += amount
        tokens += usage
        priced += 1
        retrospective += int(reservation.get('pricing') is None)
        bucket = by_kind[reservation.get('kind', 'unknown')]
        bucket['costMicros'] += amount
        bucket['inputTokens'] += usage
        bucket['pricedAttempts'] += 1
    return {'currency': 'USD', 'estimatedAmount': f'{micros // 1000000}.{micros % 1000000:06d}', 'costMicros': str(micros), 'pricedAttempts': priced, 'retrospectivelyPricedAttempts': retrospective, 'unknownUsageAttempts': unknown, 'pendingAttempts': pending, 'reportedInputTokens': tokens, 'partial': priced != len(reserved), 'pricing': pricing, 'byKind': {k: {**v, 'costMicros': str(v['costMicros'])} for k, v in by_kind.items()}, 'label': 'Estimated input-token spend at published list rates; not an invoice. Output listed as free; taxes, credits, discounts and other charges excluded.'}


def atomic_json(path, value):
    temporary = path.with_suffix(f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    for attempt in range(100):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 99:
                raise
            time.sleep(.05)


if __name__ == '__main__':
    rows = read_jsonl(RUN / 'results.jsonl')
    status = json.loads((RUN / 'status.json').read_text())
    pricing_file = RUN / 'pricing.json'
    pricing = json.loads(pricing_file.read_text()) if pricing_file.exists() else None
    costs = cost_summary(read_jsonl(RUN / 'attempts.jsonl'), pricing, status['model'])
    report = {'state': status['state'], 'asOf': status['updatedAt'], 'interim': status['state'] != 'completed', 'completed': len(rows), 'attempts': status['attempts'], 'reportedInputTokens': status['inputTokens'], 'unknownUsageAttempts': status['unknownUsage'], 'estimatedDollarCost': None, 'model': status['model'], 'threshold': status['threshold'], 'policyHash': status['policyHash'], 'emailsIncluded': False, 'datasets': {}, 'limitations': ['Published annotations have not been independently adjudicated.', 'Spam is a proxy label for scams, and DISC21 source identity is a proxy for partial matching.', 'Primary-score agreement does not include safety/context gates and is not the enforcement decision.', 'Abstentions and failures are excluded from decided-case recall; all-positive detection rate includes them.', 'Public benchmark contamination in the provider model is unknown.', 'Naturalistic Discord accuracy and production acceptance remain unverified.']}
    for kind in ['text', 'content', 'reference']:
        group = [r for r in rows if r['kind'] == kind]
        latency = sorted(r['elapsedMs'] for r in group if 'answer' in r)
        report['datasets'][kind] = {'cases': len(group), 'gatedDecision': confusion(group), 'primaryScoreOnly': confusion(group, primary=True), 'latencyMs': {'p50': statistics.median(latency) if latency else None, 'p95': latency[min(len(latency) - 1, int(.95 * len(latency)))] if latency else None}, 'abstentionReasons': dict(collections.Counter(reason for r in group for reason in r.get('gate', {}).get('blockedReasons', []))), 'errors': dict(collections.Counter(r['error'] for r in group if r.get('error')))}
    report['cost'] = costs
    report['estimatedDollarCost'] = costs['estimatedAmount'] if costs else None
    if costs:
        report['reportedInputTokens'] = costs['reportedInputTokens']
        atomic_json(RUN / 'costs.json', costs)
    atomic_json(RUN / 'report.json', report)
    print(json.dumps({k: report[k] for k in ['state', 'interim', 'completed', 'attempts', 'reportedInputTokens', 'estimatedDollarCost']}))
    if '--watch' in sys.argv:
        # This helper only reads receipts; it never dispatches provider requests.
        while status['state'] in ['running', 'waiting_for_data']:
            time.sleep(30)
            subprocess.run([sys.executable, __file__], check=True)
            status = json.loads((RUN / 'status.json').read_text())
