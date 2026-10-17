"""Download non-email benchmark data to the explicitly selected G: scratch drive.

No credentials are read. DISC21 ZIP members are fetched with HTTP ranges, avoiding
the 350 GB full download. Published labels remain source labels, not adjudications
of the application's stricter moderation policies.
"""
import concurrent.futures
import csv
import hashlib
import io
import json
import os
import pathlib
import random
import struct
import time
import zipfile
import zlib

import requests

ROOT = pathlib.Path(os.environ.get('BENCHMARK_ROOT', 'G:/datasets-deleteme/typecheck'))
RAW = ROOT / 'raw'
RAW.mkdir(parents=True, exist_ok=True)


def record(event, **values):
    print(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **values}), flush=True)


def download(url, target):
    target = pathlib.Path(target)
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + '.part')
    # Downloads are atomic. A partially transferred archive is never extracted.
    for attempt in range(3):
        try:
            with requests.get(url, stream=True, timeout=(30, 90)) as response:
                response.raise_for_status()
                with part.open('wb') as out:
                    for chunk in response.iter_content(1024 * 1024):
                        out.write(chunk)
            part.replace(target)
            record('downloaded', file=str(target), bytes=target.stat().st_size)
            return target
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def archive_dataset(ref, name):
    metadata = requests.get('https://www.kaggle.com/api/v1/datasets/view/' + ref, timeout=30)
    metadata.raise_for_status()
    (RAW / (name + '-metadata.json')).write_text(json.dumps(metadata.json(), indent=2), encoding='utf-8')
    archive = download('https://www.kaggle.com/api/v1/datasets/download/' + ref, RAW / (name + '.zip'))
    dest = RAW / name
    dest.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            path = (dest / member.filename).resolve()
            if not path.is_relative_to(dest.resolve()):
                raise ValueError('unsafe_archive_path')
        z.extractall(dest)
    return dest


class RemoteZip(io.RawIOBase):
    """Seekable read-only ZIP transport; fails if server ignores byte ranges."""
    def __init__(self, url):
        self.url = url
        self.pos = 0
        r = requests.get(url, headers={'Range': 'bytes=-65536'}, timeout=60)
        if r.status_code != 206:
            raise ValueError('range_requests_required')
        self.size = int(r.headers['Content-Range'].split('/')[-1])
        self.tail = r.content

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def tell(self):
        return self.pos

    def read(self, size=-1):
        end = self.size if size < 0 else min(self.size, self.pos + size)
        if end <= self.pos:
            return b''
        if self.pos >= self.size - len(self.tail):
            result = self.tail[self.pos - (self.size - len(self.tail)):end - (self.size - len(self.tail))]
        else:
            r = requests.get(self.url, headers={'Range': f'bytes={self.pos}-{end - 1}'}, timeout=60)
            if r.status_code != 206 or len(r.content) != end - self.pos:
                raise ValueError('invalid_range_response')
            result = r.content
        self.pos = end
        return result


def prepare_disc():
    ref = 'hmendonca/disc21'
    truth = download('https://www.kaggle.com/api/v1/datasets/download/' + ref + '/dev_ground_truth.csv', RAW / 'disc21/dev_ground_truth.csv')
    pairs = list(csv.reader(truth.open()))
    random.Random(20261017).shuffle(pairs)
    # Restrict source references to one shard for an economical first run.
    pairs = [(q, r) for q, r in pairs if r.startswith('R') and int(r[1:]) < 50000][:500]
    if len(pairs) < 2:
        raise ValueError('disc21_ground_truth_unavailable')
    reference_url = 'https://dl.fbaipublicfiles.com/image_similarity_challenge/public/references_0.zip'
    query_url = 'https://dl.fbaipublicfiles.com/image_similarity_challenge/public/dev_queries.zip'
    def index(url):
        with zipfile.ZipFile(RemoteZip(url)) as archive:
            return {pathlib.PurePosixPath(n.filename).stem: n for n in archive.infolist() if n.filename.endswith('.jpg')}
    references, queries = index(reference_url), index(query_url)
    def member(url, entry, target):
        if target.exists():
            return
        start = entry.header_offset
        # Include slack for local extra fields; verify the decompressed CRC/size.
        response = requests.get(url, headers={'Range': f'bytes={start}-{start + entry.compress_size + 65535}'}, timeout=60)
        response.raise_for_status()
        if response.status_code != 206:
            raise ValueError('range_requests_required')
        data = response.content
        if data[:4] != b'PK\x03\x04':
            raise ValueError('invalid_zip_local_header')
        name_len, extra_len = struct.unpack_from('<HH', data, 26)
        offset = 30 + name_len + extra_len
        compressed = data[offset:offset + entry.compress_size]
        output = zlib.decompress(compressed, -15) if entry.compress_type == 8 else compressed
        if len(output) != entry.file_size or zlib.crc32(output) != entry.CRC:
            raise ValueError('zip_member_integrity_failure')
        target.write_bytes(output)
    def pair_files(pair):
        query, reference = pair
        for attempt in range(3):
            try:
                member(reference_url, references[reference], RAW / 'disc21' / (reference + '.jpg'))
                member(query_url, queries[query], RAW / 'disc21' / (query + '.jpg'))
                return
            except requests.RequestException:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
    cases = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for i, _ in enumerate(pool.map(pair_files, pairs)):
            query, reference = pairs[i]
            dst = RAW / 'disc21' / (reference + '.jpg')
            qpath = RAW / 'disc21' / (query + '.jpg')
            cases.append({'id': 'disc-positive-' + query.lower(), 'kind': 'reference', 'reference': str(dst), 'file': str(qpath), 'expected': True, 'mode': 'partial', 'dataset': 'disc21', 'sourceGroup': reference, 'labelType': 'published_copy_relation_proxy'})
            other = pairs[(i + 1) % len(pairs)][1]
            if other != reference:
                cases.append({'id': 'disc-negative-' + query.lower(), 'kind': 'reference', 'reference': str(RAW / 'disc21' / (other + '.jpg')), 'file': str(qpath), 'expected': False, 'mode': 'partial', 'dataset': 'disc21', 'sourceGroup': reference, 'labelType': 'different_published_source_proxy'})
            if i % 25 == 0:
                record('disc_progress', completed=i + 1, requested=len(pairs))
    return cases


def prepare_text():
    dest = archive_dataset('julian3833/jigsaw-toxic-comment-classification-challenge', 'jigsaw')
    train = next(dest.rglob('train.csv'))
    rows = list(csv.DictReader(train.open(encoding='utf-8')))
    random.Random(20261017).shuffle(rows)
    # Broad source toxicity label: explicitly a benchmark policy, not a starter.
    seen, cases = set(), []
    for row in rows:
        text = row['comment_text']
        h = hashlib.sha256(text.encode()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        cases.append({'id': 'jigsaw-' + row['id'], 'kind': 'text', 'text': text, 'expected': any(row[k] == '1' for k in ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate']), 'labels': {k: int(row[k]) for k in ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate']}, 'dataset': 'jigsaw', 'sourceGroup': h, 'split': 'held_out', 'labelType': 'published_annotation'})
    (ROOT / 'jigsaw-corpus.json').write_text(json.dumps(cases), encoding='utf-8')
    # Natural-prevalence held-out sample; no threshold tuning on these cases.
    return cases[:10000]


def prepare_images():
    dest = archive_dataset('tiharajayawickrama/spam-misleading-images-dataset', 'spam-images')
    paths = sorted(p for p in dest.rglob('*') if p.suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp'])
    random.Random(20261017).shuffle(paths)
    seen, cases = set(), []
    for p in paths:
        label = p.parent.name.lower()
        if label not in ['ham', 'spam']:
            continue
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        cases.append({'id': 'spam-image-' + h[:24], 'kind': 'content', 'file': str(p), 'expected': label == 'spam', 'dataset': 'spam-images', 'sourceGroup': h, 'labelType': 'spam_label_proxy_for_scam_policy', 'split': 'source_test' if 'test' in str(p.relative_to(dest)).lower() else 'source_train_or_validation'})
    return cases


if __name__ == '__main__':
    jobs = {'text': prepare_text, 'content': prepare_images, 'reference': prepare_disc}
    all_cases, failures = [], {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(f): name for name, f in jobs.items()}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                cases = future.result()
                (ROOT / (name + '-manifest.json')).write_text(json.dumps(cases), encoding='utf-8')
                all_cases.extend(cases)
                record('prepared', kind=name, cases=len(cases))
            except Exception as e:
                failures[name] = type(e).__name__ + ': ' + str(e)[:180]
                record('preparation_failed', kind=name, error=failures[name])
    # Interleave datasets so fresh useful results cover all available modalities.
    grouped = [[c for c in all_cases if c['kind'] == k] for k in jobs]
    merged = []
    for i in range(max(map(len, grouped), default=0)):
        for group in grouped:
            if i < len(group):
                merged.append(group[i])
    (ROOT / 'manifest.json').write_text(json.dumps(merged), encoding='utf-8')
    (ROOT / 'preparation.json').write_text(json.dumps({'cases': len(merged), 'failures': failures, 'seed': 20261017, 'emailsIncluded': False}, indent=2), encoding='utf-8')
    record('ready', cases=len(merged), failures=failures)
    if not merged:
        raise SystemExit(1)
