export interface LabeledContentResult { category: string; language: string; split: 'tuning' | 'held_out'; expected: boolean | null; predicted: boolean | null }
export function contentMetrics(rows: LabeledContentResult[]) {
    const groups = new Map<string, LabeledContentResult[]>();
    for (const r of rows) for (const key of [`${r.split}/all`, `${r.split}/category/${r.category}`, `${r.split}/language/${r.language}`]) groups.set(key, [...(groups.get(key) ?? []), r]);
    return Object.fromEntries([...groups].map(([key, rs]) => {
        const judged = rs.filter(r => r.expected !== null && r.predicted !== null);
        const tp = judged.filter(r => r.expected && r.predicted).length, fp = judged.filter(r => !r.expected && r.predicted).length;
        const fn = judged.filter(r => r.expected && !r.predicted).length, tn = judged.filter(r => !r.expected && !r.predicted).length;
        const abstentions = rs.filter(r => r.predicted === null).length;
        return [key, { total: rs.length, tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, abstentions, coverage: rs.length ? (rs.length - abstentions) / rs.length : null, ambiguousLabels: rs.filter(r => r.expected === null).length, note: 'Precision/recall exclude abstentions and ambiguous labels; inspect coverage alongside them.' }];
    }));
}
