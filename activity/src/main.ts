import { canManageServer } from '../../shared/domain.js';
import { setupPanel } from './onboarding.js';
import type { Pack, PackPreview, ImportOptions, PackKind } from '../../shared/packs.js';
async function editDefinition(d: any) {
    const name = input(d.name), content = structuredClone(d.content), body = h('div', { class: 'form-stack' }, field('Definition name', name));
    const fields: Record<string, HTMLTextAreaElement> = {};
    for (const key of ['question', 'positive', 'negative', 'exceptions', 'contextRequirements']) {
        const area = h('textarea', { rows: 4, value: content[key] });
        fields[key] = area;
        body.append(field(pretty(key), area));
    }
    const dialog = modal('Edit image-analysis definition', 'Existing rules retain their own prompt snapshots.', body, [button('Save definition', async () => { for (const [key, area] of Object.entries(fields))
            content[key] = area.value; await api('packs/definitions/' + d.id, 'PUT', { revision: d.revision, name: name.value, content: parseContent(content) }); dialog.close(); await render(); })]);
}
async function packsPage(parent: HTMLElement) {
    parent.classList.add('packs-page');
    const [starters, images, groups, rules, definitions] = await Promise.all([
        api<{
            id: string;
            name: string;
            description: string;
        }[]>('packs/starters'), api<ReferenceImage[]>('images'), api<Group[]>('groups'), api<Rule[]>('rules'), api<any[]>('packs/definitions')
    ]);
    const download = (p: Pack) => { const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); const a = h('a', { href: url, download: p.id + '.typecheck.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    let loaded: Pack | null = null, plan: PackPreview | null = null;
    let options: ImportOptions = {};
    const previewArea = h('div', { 'aria-live': 'polite' }), mappingsArea = h('div', { class: 'form-stack' }), conflictsArea = h('div', { class: 'form-stack' });
    const policy = check('Apply portable policy settings and delegated permissions', false, 'Requires mappings. Turns global enforcement and high-impact sanctions off. Existing grants with different capabilities must be reconciled in Permissions first.');
    const restore = check('Restore components previously deleted from this pack', false, 'Explicitly adds removed examples again. Leave off to preserve deletions.');
    const mappings: Record<string, HTMLSelectElement> = {}, choices: Record<string, HTMLSelectElement> = {};
    const refreshOptions = () => { options = { policy: policy.box.checked, restoreDeleted: restore.box.checked, mappings: Object.fromEntries(Object.entries(mappings).filter(([, v]) => v.value).map(([k, v]) => [k, v.value])), choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, v.value as 'keep' | 'replace'])) }; };
    const invalidate = () => { plan = null; apply.disabled = true; apply.dataset.locked = 'true'; };
    const previewButton = button('Validate and preview import', async () => {
        if (!loaded)
            throw Error('Choose a file or starter first');
        refreshOptions();
        plan = await api<PackPreview>('packs/preview', 'POST', { pack: loaded, options });
        for (const c of plan.components.filter(c => !['addition', 'previously deleted'].includes(c.status)))
            if (!choices[c.id]) {
                const choice = select([['keep', 'Keep destination (safe default)'], ['replace', 'Replace with pack version; remove approval']], 'keep');
                choices[c.id] = choice;
                choice.addEventListener('change', invalidate);
                conflictsArea.append(field(c.name + ' · ' + c.status, choice));
            }
        previewArea.replaceChildren(panel('Import preview', `${plan.pack.id} · ${plan.pack.version}`, h('p', {}, plan.pack.description), ...plan.warnings.map(w => h('p', { class: 'notice' }, w)), table(['Component', 'Type', 'Change', 'Decision', 'Dependencies'], plan.components.map(c => [c.name, c.kind, c.status, c.choice, c.dependencies.join(', ') || 'None'])), h('h3', {}, 'Intended rule behavior'), ...plan.intendedRules.map(r => h('p', {}, `${r.name}: ${r.policy.type}, ${r.policy.action}, threshold ${r.policy.threshold}. Source enabled=${r.policy.enabled}, automatic=${r.policy.automatic}. Imported enabled=false, automatic=false, approval required.`)), h('details', {}, h('summary', {}, 'Included policy settings (destination values require mapping)'), h('pre', {}, JSON.stringify(plan.intendedSettings, null, 2))), h('h3', {}, 'Policy changes and permissions'), h('p', {}, policy.box.checked ? 'Policy application selected; mappings will be used.' : 'Policy application is off; existing settings and grants will be kept.'), table(['Setting', 'Destination', 'Pack intent'], plan.policyChanges.map(c => [c.setting, JSON.stringify(c.destination), JSON.stringify(c.intended)])), table(['Destination role / binding', 'Capabilities', 'Grant decision'], plan.grants.map(g => [g.role, g.capabilities.join(', '), g.status])), h('h3', {}, 'Validation evidence'), ...(plan.evidence.length ? plan.evidence.map(e => h('p', {}, `${e.kind}: ${e.status}. Source: ${e.source}`)) : [h('p', {}, 'No validation evidence supplied.')]), h('small', {}, 'Pack digest: ' + plan.digest)));
        apply.disabled = false;
        apply.dataset.locked = 'false';
    });
    const apply = button('Apply this preview', async () => {
        if (!loaded || !plan)
            throw Error('Preview required');
        const result = await api('packs/apply', 'POST', { pack: loaded, options, token: plan.token });
        if(options.policy) {
            settings=await api<SettingsVersion>('settings');
            const state=document.querySelector('.topbar .badge');
            if(state) {state.textContent='MONITOR ONLY';state.className='badge amber';}
        }
        invalidate();
        previewArea.append(panel('Import complete', 'Saved atomically; audit receipt recorded.', h('p', {}, `${result.added} added · ${result.replaced} replaced · ${result.kept} kept`), h('p', {}, 'Review rules, map channels, test with your examples, approve the destination configuration, then enable automatic enforcement separately.')));
        message('Pack imported. Automatic enforcement is off for imported rules.');
    });
    apply.disabled = true;
    apply.dataset.locked = 'true';
    const load = (p: Pack) => {
        if (!Array.isArray(p.components) || p.components.length > 1000 || (p.policy?.bindings?.length ?? 0) > 1000)
            throw Error('Invalid pack or component limit exceeded');
        loaded = p;
        plan = null;
        apply.disabled = true;
        for (const k of Object.keys(mappings))
            delete mappings[k];
        for (const k of Object.keys(choices))
            delete choices[k];
        conflictsArea.replaceChildren();
        mappingsArea.replaceChildren();
        previewArea.replaceChildren(h('p', { class: 'notice' }, `${p.id} · ${p.version} loaded. Validate before applying.`));
        for (const b of p.policy?.bindings ?? []) {
            const values = b.kind === 'role' ? meta.roles : meta.channels;
            const choice = select([['', 'Choose destination ' + b.kind], ...values.map(v => [v.id, v.name ?? v.id] as [
                    string,
                    string
                ])], '');
            mappings[b.id] = choice;
            choice.addEventListener('change', invalidate);
            mappingsArea.append(field(b.purpose + ' · ' + b.id, choice));
        }
    };
    policy.box.addEventListener('change', invalidate);
    restore.box.addEventListener('change', invalidate);
    parent.append(panel('Start with a pack', 'Editable starting points. Human review, software compatibility, measured model evaluation and live validation are separate evidence categories.', ...starters.map(s => h('div', { class: 'pack-starter' }, h('div', {}, h('h3', {}, s.name), h('p', { class: 'muted' }, s.description)), button('Select ' + s.name, async () => { loaded = null; invalidate(); previewButton.disabled = true; try {
        load(await api<Pack>('packs/starter/' + s.id));
    }
    finally {
        previewButton.disabled = false;
    } }, 'quiet')))));
    const file = h('input', { type: 'file', accept: '.json,.typecheck.json,application/json' });
    file.addEventListener('change', () => { void (async () => { const f = file.files?.[0]; if (!f)
        return; if (f.size > 48 * 1024 * 1024)
        throw Error('Pack exceeds 48 MiB'); load(JSON.parse(await f.text())); })().catch(fail); });
    parent.append(panel('Import a pack', 'Upload → validate and preview → resolve conflicts and mappings → preview again → apply.', field('Pack file', file), policy.node, restore.node, mappingsArea, conflictsArea, h('div', { class: 'actions wrap' }, previewButton, apply), previewArea));
    const selected: {
        kind: PackKind;
        id: string;
        box: HTMLInputElement;
    }[] = [];
    const selection = h('div', { class: 'pack-component-list' });
    for (const [kind, items] of [['groups', groups], ['images', images], ['definitions', definitions], ['rules', rules]] as const)
        for (const item of items) {
            const c = check(`${kind}: ${item.name}`, false);
            selected.push({ kind, id: item.id, box: c.box });
            selection.append(c.node);
        }
    const complete = check('Complete configuration', false, 'All reference images, groups, image/text rules, prompt definitions, policy settings and delegated permissions. Excludes credentials, history, jobs and operational state. Destination channels and roles become mapping placeholders.');
    const name = input('my-moderation-pack'), version = input('1.0.0'), exportArea = h('div');
    let exported: Pack | null = null;
    parent.append(panel('Export components or a complete setup', 'Required image and group dependencies are included automatically. Settings travel as policy; applying them is explicit at the destination.', field('Pack identity (lowercase letters, numbers and hyphens)', name), field('Pack version', version), complete.node, h('details', {}, h('summary', {}, 'Select individual components or a collection'), selection), button('Preview export', async () => { exported = await api<Pack>('packs/export', 'POST', { complete: complete.box.checked, components: selected.filter(c => c.box.checked).map(({ kind, id }) => ({ kind, id })), name: name.value, version: version.value }); exportArea.replaceChildren(h('p', {}, `${exported.components.length} components · ${exported.assets.length} bundled images. Dependencies resolved.`), table(['Included component', 'Type', 'Dependencies'], exported.components.map(c => [c.name, c.kind, c.dependencies.join(', ') || 'None'])), button('Download pack file', () => download(exported!))); }), exportArea));
    const history = await api<any[]>('packs/history');
    if (history.length)
        parent.append(panel('Imported pack evidence', 'Historical declarations remain separate from destination approval.', table(['Pack', 'Imported versions', 'Evidence status'], history.map(r => [r.id, r.versions.join(', '), r.status]))));
    if (definitions.length)
        parent.append(panel('Saved image-analysis definitions', 'Standalone prompts are editable. Rules contain independent snapshots; editing a definition does not silently change a rule.', ...definitions.map(d => h('div', {}, h('h3', {}, d.name), h('p', {}, d.content.question), button('Create rule from ' + d.name, () => editRule(undefined, d.content), 'quiet'), button('Edit definition', () => editDefinition(d), 'quiet')))));
}
import { TEXT_STARTERS } from '../../shared/text-starters.js';
import { TEXT_LIMITS, parseText } from '../../shared/text.js';
import type { HistoricalScan } from '../../shared/historical.js';
import { activityAuth, apiResponse, HttpError, serializeConnection } from './connection.js';
import { timeoutPreset } from '../../shared/domain.js';
import { CONTENT_PRESETS, CONTENT_VERSION, parseContent } from '../../shared/content.js';
import { money, type AnalyticsReport, type Bucket, type Attempt, type Rate } from '../../shared/analytics.js';
import { MATCH_THRESHOLDS, DEFAULT_RULE_THRESHOLD, matchThreshold, parseRule, parseSettings, effectiveThreshold, type Action, ACTIONS, MODES, RULE_TYPES, CAPABILITIES, ADMIN_ONLY, DEFAULT_SETTINGS, type Authority, type Capability, type Group, type ReferenceImage, type Rule, type Settings, type RoleGrant, type ModerationEvent, type Calibration } from '../../shared/domain.js';
interface SDK {
    guildId: string | null;
    ready(): Promise<void>;
    commands: {
        authorize(v: {
            client_id: string;
            response_type: 'code';
            state: string;
            prompt: 'none';
            scope: string[];
        }): Promise<{
            code: string;
        }>;
        authenticate(v: {
            access_token: string;
        }): Promise<unknown>;
    };
}
interface Metadata {
    name: string;
    roles: {
        id: string;
        name: string;
        permissions: string;
    }[];
    channels: {
        id: string;
        name?: string;
        type: number;
    }[];
}
interface SettingsVersion {
    value: Settings;
    revision: number;
}
interface RuleView extends Rule {
    approvalCurrent?: boolean;
}
type Child = Node | string | number | false | null | undefined;
const app = document.querySelector<HTMLDivElement>('#app')!;
let session = '', guild = '', authority: Authority | null = null, sdk: SDK | null = null, meta: Metadata = { name: '', roles: [], channels: [] }, settings: SettingsVersion | null = null, page = 'Overview', preview = false;
let status: HTMLDivElement;
let browserDashboardUrl='/setup';
let agentSetup: ReturnType<typeof setupPanel> | undefined;
function clearAgentSetup() { agentSetup?.stop(); agentSetup = undefined; }
function initializeAgentSetup() {
    clearAgentSetup();
    if (!admin() || preview) return;
    const expectedGuild=guild, expectedSession=session;
    agentSetup=setupPanel(async (...args)=>{
        if(guild!==expectedGuild||session!==expectedSession)throw new HttpError('session_changed',401);
        const result=await api(...args);
        if(args[0]==='onboarding/apply'&&result.receipt) settings={value:result.after,revision:result.receipt.settingsRevision};
        if(args[0]==='pause'){settings=await api<SettingsVersion>('settings');void render().catch(fail);}
        return result;
    },()=>{page='Agent setup';void render().catch(fail);},browserDashboardUrl);
}
window.addEventListener('pagehide',clearAgentSetup);
const can = (cap: Capability) => authority?.capabilities.includes(cap) ?? false;
const admin = () => canManageServer(authority);
const pretty = (s: string) => s === 'severe_threshold_must_not_be_lower' ? 'Action floors must satisfy timeout <= kick <= ban.' : s === 'match_threshold_must_be_a_finite_number_from_0.5_to_1.0' ? 'Match threshold must be a finite number from 0.5 to 1.0 (inclusive).' : s.replaceAll('_', ' ');
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false)
            continue;
        if (key.startsWith('on') && typeof value === 'function')
            el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        else if (key === 'class')
            el.className = String(value);
        else if (key in el && ['value', 'checked', 'disabled', 'multiple', 'selected', 'type', 'placeholder', 'name', 'min', 'max', 'step', 'accept', 'autocomplete', 'required'].includes(key))
            (el as any)[key] = value;
        else
            el.setAttribute(key, String(value));
    }
    for (const child of children)
        if (child !== null && child !== undefined && child !== false)
            el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return el;
}
function message(value: string, error = false) { if (status) {
    status.textContent = value;
    status.className = error ? 'notice error' : 'notice';
    status.hidden = false;
} }
function fail(e: unknown) {
    const text = e instanceof Error ? pretty(e.message) : 'Request failed';
    message(text, true);
    const open = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
    if (open) {
        open.querySelector('.modal-error')?.remove();
        (open.querySelector('.window-body') ?? open).prepend(h('div', { class: 'notice error modal-error', role: 'alert' }, text));
    }
    else if (!status)
        app.replaceChildren(h('main', { class: 'login' }, h('h1', {}, 'Unable to load TypeCheck'), h('p', { role: 'alert' }, text), button('Retry', () => start())));
}
function button(label: string, run: () => void | Promise<unknown>, kind = 'primary') {
    const b = h('button', { type: 'button', class: `button ${kind}` }, label);
    b.addEventListener('click', () => { b.disabled = true; Promise.resolve().then(run).catch(fail).finally(() => { b.disabled = b.dataset.locked === 'true'; }); });
    return b;
}
function field(label: string, input: HTMLElement, hint?: string) { return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', {}, hint) : null); }
function input(value: string, type = 'text') { return h('input', { type, value }); }
function check(label: string, checked: boolean, hint?: string) { const box = h('input', { type: 'checkbox', checked }); return { box, node: h('label', { class: 'check' }, box, h('span', {}, label, hint ? h('small', {}, hint) : null)) }; }
function select(options: [
    string,
    string
][], value: string) { const s = h('select'); for (const [id, name] of options)
    s.append(h('option', { value: id }, name)); s.value = value; return s; }
function badge(label: string, kind = 'neutral') { return h('span', { class: `badge ${kind}` }, label); }
function frame<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, title: Child, ...children: Child[]) { return h(tag, { class: `${cls} window` }, h('div', { class: 'window-bar' }, title), h('div', { class: 'window-body' }, ...children)); }
function panel(title: string, subtitle?: string, ...children: Child[]) { return frame('section', 'panel', h('h2', {}, title), subtitle ? h('p', { class: 'muted panel-sub' }, subtitle) : null, ...children); }
function date(s: string) { return new Date(s).toLocaleString(); }
function table(headers: string[], rows: Child[][]) { return h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...headers.map(t => h('th', { scope: 'col' }, t)))), h('tbody', {}, ...rows.map(row => h('tr', {}, ...row.map(c => h('td', { class: typeof c === 'string' || typeof c === 'number' ? 'cell-data' : undefined }, c))))))); }
function empty(title: string, detail: string) { return h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, detail)); }
async function api<T = any>(path: string, method = 'GET', body?: unknown, global = false): Promise<T> {
    const response = await fetch(global ? path : `/api/g/${guild}/${path}`, { method, headers: { ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok && [401,403].includes(response.status)) clearAgentSetup();
    if (response.status === 401) session = '';
    return apiResponse<T>(response);
}
async function blobRequest(path: string) { const r = await fetch(`/api/g/${guild}/${path}`, { headers: { Authorization: `Bearer ${session}` } }); if (!r.ok)
    throw new Error('Cannot retrieve file'); return r.blob(); }
async function base64(file: File) { if (file.size > 8 * 1024 * 1024)
    throw new Error('Maximum image size is 8 MiB'); return new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]!); r.onerror = reject; r.readAsDataURL(file); }); }
function download(blob: Blob, name: string) { const u = URL.createObjectURL(blob); const a = h('a', { href: u, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
function modal(title: string, description: string, body: HTMLElement, actions: HTMLElement[]) {
    const d = frame('dialog', 'modal', h('h2', {}, title), h('p', { class: 'muted' }, description), body, h('div', { class: 'actions' }, ...actions));
    const close = () => d.close();
    d.addEventListener('close', () => d.remove());
    d.querySelector('.window-body')!.append(button('Close', close, 'quiet'));
    d.append(h('button', { type: 'button', class: 'window-close', 'aria-label': 'Close dialog', onclick: close }, '✕'));
    document.body.append(d);
    d.showModal();
    return d;
}
function confirmAction(title: string, description: string): Promise<boolean> { return new Promise(resolve => { let done = false; const d = modal(title, description, h('div'), []); const yes = button('Confirm', () => { done = true; resolve(true); d.close(); }, 'danger'); d.querySelector('.window-body')!.append(yes); d.addEventListener('close', () => { if (!done)
    resolve(false); }); }); }
function links() {
    return [
        ['Agent setup', admin() && !preview], ['Moderation packs', admin() && !preview], ['Overview', can('dashboard.view')], ['Historical scans', admin()], ['Cost & Usage', can('dashboard.view')], ['Image library', can('images.view') || can('images.add')], ['Rules & tests', can('rules.view') || can('rules.create')],
        ['Activity log', can('logs.view')], ['Permissions', admin() || can('moderators.delegate')], ['Settings', admin() || can('channels.configure')]
    ] as const;
}
interface AuthSession { accessToken?: string; sessionToken: string; authority: Authority }
let connectionClientId = '';
const authenticateSession = activityAuth<AuthSession>({
    start: async () => (await api('/api/auth/start', 'POST', {}, true)).nonce,
    authorize: async nonce => (await sdk!.commands.authorize({ client_id: connectionClientId, response_type: 'code', state: nonce, prompt: 'none', scope: ['identify'] })).code,
    exchange: (code, nonce) => api('/api/auth/exchange', 'POST', { code, nonce, guildId: guild }, true),
    renew: (accessToken, nonce) => api('/api/auth/renew', 'POST', { accessToken, nonce, guildId: guild }, true),
    authenticate: async auth => { await sdk!.commands.authenticate({ access_token: auth.accessToken! }); },
    accessToken: auth => { const token = auth.accessToken!; auth.accessToken = undefined; return token; }
});
const connectOnce = serializeConnection(async () => {
    const clientId = connectionClientId;
    message('Connecting to Discord…');
    const modulePath = '../../vendor/discord-sdk.js';
    const { DiscordSDK } = await import(modulePath);
    sdk ??= new DiscordSDK(clientId) as SDK;
    await Promise.race([sdk.ready(), new Promise((_, reject) => setTimeout(() => reject(new Error('Open this application as a Discord Activity')), 12000))]);
    if (!sdk.guildId)
        throw new Error('Launch this Activity in a Discord server, not a direct message');
    guild = sdk.guildId;
    const auth = await authenticateSession();
    session = auth.sessionToken;
    authority = auth.authority;
    meta = await api<Metadata>('meta');
    if (can('dashboard.view') || admin() || can('channels.configure'))
        settings = await api<SettingsVersion>('settings');
    const first = links().find(([, allowed]) => allowed);
    page = first?.[0] ?? 'Overview';
    initializeAgentSetup();
    await render();
});
async function connect(clientId: string) { connectionClientId = clientId; return connectOnce(); }
async function render() {
    app.replaceChildren();
    const nav = h('nav', { 'aria-label': 'Administration', class: 'nav' });
    for (const [label, allowed] of links())
        if (allowed)
            nav.append(button(label, async () => { page = label; await render(); }, label === page ? 'nav-active' : 'nav-item'));
    const aside = h('aside', { class: 'sidebar' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'J'), h('div', {}, h('strong', {}, 'TYPECHECK'), h('small', {}, 'Powered by Jev'))), h('p', { class: 'nav-label' }, 'ADMINISTRATION'), nav, h('div', { class: 'sidebar-footer' }, badge(preview ? 'OFFLINE PREVIEW' : 'EXPERIMENTAL', 'amber'), h('p', {}, 'Text + image moderation'), h('small', {}, 'v0.1.0 · Server-scoped access')));
    status = h('div', { class: 'notice', role: 'status' });
    status.hidden = true;
    const enforcement = settings?.value.enforcement;
    const header = h('header', { class: 'topbar' }, h('div', {}, h('p', { class: 'eyebrow' }, location.pathname === '/setup' ? 'BROWSER DASHBOARD' : 'DISCORD ACTIVITY'), h('strong', {}, meta.name)), h('div', { class: 'actions' }, badge(enforcement ? 'ENFORCEMENT ON' : 'MONITOR ONLY', enforcement ? 'green' : 'amber'), button('Refresh', () => render(), 'quiet'), button('Log out / reconnect', async () => { clearAgentSetup(); await api('/api/auth/logout', 'POST', {}, true).catch(()=>{}); session = ''; authority = null; settings = null; await start(false); }, 'quiet'), can('enforcement.pause') ? button('Pause enforcement', async () => { await api('pause', 'POST', {}); if (settings)
        settings.value.enforcement = false; await render(); message('Automatic enforcement paused. Requests already in flight may still finish.'); }, 'danger') : null));
    const content = h('main', { class: 'content' }, h('div', { class: 'page-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'CONTROL PANEL'), h('h1', {}, page)), badge('GUILD ' + guild)), status);
    if (preview)
        content.append(frame('div', 'preview-banner', 'OFFLINE, READ-ONLY PREVIEW', h('p', {}, 'sample data only. No Discord or Jev requests are performed.')));
    app.append(h('div', { class: 'shell' }, aside, h('div', { class: 'workspace' }, header, content)));
    const loading = h('div', { class: 'loading' }, 'Loading…');
    content.append(loading);
    try {
        authority = await api<Authority>('me');
        if (page === 'Agent setup') { const setup=h('section', {class:'form-stack'}); content.append(setup); agentSetup?.mount(setup); }
        else if (page === 'Moderation packs')
            await packsPage(content);
        else if (page === 'Overview')
            await overview(content);
        else if (page === 'Historical scans')
            await historicalPage(content);
        else if (page === 'Cost & Usage')
            await costsPage(content);
        else if (page === 'Image library')
            await library(content);
        else if (page === 'Rules & tests')
            await rulesPage(content);
        else if (page === 'Activity log')
            await logs(content);
        else if (page === 'Permissions')
            await permissions(content);
        else if (page === 'Settings')
            await settingsPage(content);
    }
    catch (e) {
        fail(e);
    }
    finally {
        loading.remove();
    }
}
async function overview(parent: HTMLElement) {
    const data = await api('dashboard');
    settings = data.settings;
    parent.append(h('section', { class: 'hero' }, h('div', {}, badge('ONE WORKFLOW. NO TEXT MODERATION.'), h('h2', {}, 'Match an image.\nApply your policy.'), h('p', {}, 'Jev evaluates posted images against this server’s reference library. The bot keeps monitoring when this Activity closes.')), h('div', { class: 'health-stack' }, h('p', {}, badge(data.botOnline ? 'BOT CONNECTED' : 'BOT OFFLINE', data.botOnline ? 'green' : 'red')), h('p', {}, badge('JEV ' + data.credential.status.toUpperCase(), data.credential.status === 'valid' ? 'green' : 'amber')), h('small', {}, settings!.value.model))));
    try { const report = await api<AnalyticsReport>('analytics/summary'); parent.append(panel('Estimated Jev input-token cost today', 'Operator-entered rates. This is not a provider invoice.', costSummary(report))); } catch { parent.append(panel('Estimated cost unavailable', 'Usage analytics could not be loaded. Refresh to retry.')); }
    const counts = data.counts;
    parent.append(h('div', { class: 'stats' }, ...[[counts.images, 'Active reference images'], [counts.rules, 'Active rules'], [counts.evaluations, 'Retained evaluations'], [counts.successful, 'Events with successful actions']].map(([n, label]) => h('section', { class: 'stat' }, h('strong', {}, n), h('span', {}, label)))));
    const setup = h('div', { class: 'checklist' }, ...[[data.credential.configured, 'Configure a Jev key'], [counts.images > 0, 'Upload reference images'], [counts.rules > 0, 'Create and test a rule'], [settings!.value.channels.length > 0, 'Choose monitored channels'], [settings!.value.enforcement, 'Enable enforcement after approval']].map(([done, label]) => h('div', { class: 'checklist-row' }, badge(done ? 'DONE' : 'NEXT', done ? 'green' : 'neutral'), h('span', {}, label))));
    parent.append(h('div', { class: 'columns' }, panel('Setup checklist', 'New servers begin with no channels selected and enforcement off.', setup), panel('Usage & safeguards', 'A probability threshold is not an accuracy guarantee.', h('div', { class: 'usage' }, h('strong', {}, `${data.usage.calls} / ${settings!.value.dailyCallLimit}`), h('span', {}, 'Quota reservations today (UTC)'), h('progress', { value: data.usage.calls, max: settings!.value.dailyCallLimit }), h('p', {}, `${Number(data.usage.inputTokens).toLocaleString()} reported input tokens`)), h('p', { class: 'muted' }, 'Kick and ban require representative labeled examples, server-manager approval, and a second Jev check.'))));
    parent.append(panel('Recent moderation events', 'Outcomes are recorded separately from intended actions.', data.recent.length ? eventTable(data.recent) : empty('No moderation events', 'Create and test a text or image rule to begin. Native text rules are opt-in.')));
}
function eventTable(items: ModerationEvent[]) { return table(['Time', 'User / message', 'Intended', 'Actual result'], items.map(e => [date(e.createdAt), h('div', {}, h('code', {}, e.userId), h('small', {}, e.messageId)), badge(e.intended), h('span', { class: e.actual.includes('success') ? 'success-text' : 'muted' }, pretty(e.actual))])); }
async function library(parent: HTMLElement) {
    const images = can('images.view') ? await api<ReferenceImage[]>('images') : [], groups = can('images.view') ? await api<Group[]>('groups') : [];
    const rules = can('rules.view') ? await api<RuleView[]>('rules') : [];
    if (can('images.add')) {
        const files = h('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,image/gif' }), group = select([['', 'No group'], ...groups.map(g => [g.id, g.name] as [
                string,
                string
            ])], '');
        parent.append(panel('Add reference images', 'Still PNG, JPEG, WebP, and GIF. Up to 8 MiB each. Animated images are rejected.', h('div', { class: 'form-row' }, field('Select one or more images', files), field('Image group', group), button('Upload images', async () => {
            if (!files.files?.length)
                throw new Error('Select an image');
            let n = 0;
            for (const file of Array.from(files.files)) {
                await api('images', 'POST', { name: file.name, groupId: group.value || null, enabled: true, base64: await base64(file) });
                n++;
            }
            await render();
            message(`${n} reference images uploaded. Related rule approvals must be reviewed again.`);
        }))));
    }
    const search = input('');
    search.placeholder = 'Search images by name';
    const grid = h('div', { class: 'image-grid' });
    let visible = 24;
    const thumbnails = new Map<string, Promise<Blob>>();
    const selected = new Set<string>();
    const renderImages = () => {
        grid.replaceChildren();
        const filtered = images.filter(i => i.name.toLowerCase().includes(search.value.toLowerCase()));
        for (const image of filtered.slice(0, visible)) {
            const preview = h('img', { alt: image.name, loading: 'lazy' });
            if (!thumbnails.has(image.id))
                thumbnails.set(image.id, blobRequest(`images/${image.id}/content`));
            void thumbnails.get(image.id)!.then(b => { if (!preview.isConnected)
                return; const url = URL.createObjectURL(b); preview.src = url; preview.onload = () => URL.revokeObjectURL(url); }).catch(() => { preview.alt = 'Preview unavailable'; });
            const selection = check('Select', selected.has(image.id));
            selection.box.onchange = () => { if (selection.box.checked)
                selected.add(image.id);
            else
                selected.delete(image.id); };
            const linked = rules.filter(r => r.referenceId === image.id || r.type === 'group' && r.groupId === image.groupId || r.type === 'any_match');
            grid.append(h('article', { class: 'image-card' }, h('div', { class: 'image-preview' }, preview), h('div', { class: 'image-body' }, can('images.edit') || can('images.delete') ? selection.node : null, h('div', { class: 'card-heading' }, h('h3', {}, image.name), badge(image.enabled ? 'ACTIVE' : 'DISABLED', image.enabled ? 'green' : 'neutral')), h('p', { class: 'muted' }, groups.find(g => g.id === image.groupId)?.name ?? 'Ungrouped'), h('p', { class: 'small' }, linked.length ? linked.map(r => `${r.name}: ${r.action}`).join(' · ') : 'No visible matching rules'), h('div', { class: 'actions' }, can('images.edit') ? button('Edit', () => editImage(image, groups), 'quiet') : null, can('images.delete') ? button('Remove', async () => { if (await confirmAction('Remove reference image?', 'Individual rules must be removed first. Related group/global approvals will become stale.')) {
                await api(`images/${image.id}`, 'DELETE', { revision: image.revision });
                await render();
            } }, 'danger') : null))));
        }
        if (filtered.length > visible)
            grid.append(button('Show more images', () => { visible += 24; renderImages(); }, 'quiet'));
        if (!filtered.length)
            grid.append(empty('No reference images', 'Reference images stay in this server’s private storage. Submitted message images are not retained.'));
    };
    search.oninput = () => { visible = 24; renderImages(); };
    const bulk = async (remove: boolean) => { const chosen = images.filter(i => selected.has(i.id)); if (!chosen.length)
        throw new Error('Select reference images first'); if (!await confirmAction(remove ? 'Remove selected images?' : 'Disable selected images?', 'Individual rules must be removed before deleting a reference. Dependent approvals become stale. Changes run sequentially and may partially succeed.'))
        return; let count = 0; try {
        for (const image of chosen) {
            await api(`images/${image.id}`, remove ? 'DELETE' : 'PUT', remove ? { revision: image.revision } : { name: image.name, groupId: image.groupId, enabled: false, revision: image.revision });
            count++;
        }
    }
    finally {
        await render();
        message(`${count} of ${chosen.length} selected images updated.`);
    } };
    parent.append(h('div', { class: 'actions' }, can('images.edit') ? button('Disable selected', () => bulk(false), 'quiet') : null, can('images.delete') ? button('Remove selected', () => bulk(true), 'danger') : null));
    parent.append(panel('Reference library', `${images.length} images · Changes to reference content invalidate affected approvals.`, field('Search', search), grid));
    renderImages();
    if (can('images.edit')) {
        const name = input('');
        parent.append(panel('Image groups', 'Create a group rule to give every image in a group a default action.', h('div', { class: 'form-row' }, field('Group name', name), button('Create group', async () => { await api('groups', 'POST', { name: name.value }); await render(); })), h('div', { class: 'group-list' }, ...groups.map(g => h('div', { class: 'group-row' }, h('strong', {}, g.name), h('div', { class: 'actions' }, button('Rename', () => { const n = input(g.name); let d: HTMLDialogElement; d = modal('Rename group', 'Rules continue to refer to the same group.', field('Name', n), [button('Save', async () => { await api(`groups/${g.id}`, 'PUT', { name: n.value, revision: g.revision }); d.close(); await render(); })]); }, 'quiet'), button('Remove', async () => { if (await confirmAction('Remove group?', 'A group cannot be removed while images or rules still use it.')) {
            await api(`groups/${g.id}`, 'DELETE', { revision: g.revision });
            await render();
        } }, 'danger')))))));
    }
}
function editImage(image: ReferenceImage, groups: Group[]) {
    const name = input(image.name), group = select([['', 'No group'], ...groups.map(g => [g.id, g.name] as [
            string,
            string
        ])], image.groupId ?? ''), enabled = check('Enabled', image.enabled), file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    let d: HTMLDialogElement;
    d = modal('Edit reference image', 'Saving invalidates approvals for rules that depend on this reference.', h('div', { class: 'form-stack' }, field('Name', name), field('Group', group), enabled.node, field('Replace image (optional)', file)), [button('Save image', async () => { const selected = file.files?.[0]; await api(`images/${image.id}`, 'PUT', { name: name.value, groupId: group.value || null, enabled: enabled.box.checked, revision: image.revision, ...(selected ? { base64: await base64(selected) } : {}) }); d.close(); await render(); })]);
}
async function rulesPage(parent: HTMLElement) {
    const rules = can('rules.view') ? await api<RuleView[]>('rules') : [];
    parent.append(h('div', { class: 'notice' }, 'Default precedence: individual image → group → any matched reference → image content analysis → native text → any image. Higher numeric priority overrides this order. One user-level sanction per message.'));
    if (can('rules.create'))
        parent.append(h('div', { class: 'actions section-actions' }, button('Create rule', () => editRule()), admin() ? button('Create text rule', () => editTextRule(), 'quiet') : null));
    if(can('rules.view')) parent.append(textStarterPanel());
    parent.append(panel('Moderation rules', 'Rules do not run automatically until their current configuration is approved and enforcement is enabled.', rules.length ? table(['Rule', 'Trigger', 'Action', 'Threshold / priority', 'Approval', 'Manage'], rules.map(r => [
        h('div', {}, h('strong', {}, r.name), h('small', {}, r.enabled ? 'Enabled' : 'Disabled')), h('div', {}, pretty(r.type), h('small', {}, r.type === 'any_image' ? 'No Jev comparison' : r.type === 'text' ? r.text?.question ?? 'Text predicate' : r.type === 'content' ? r.content?.question ?? 'Content predicate' : r.mode)), h('div', {}, badge(r.action), r.deleteMessage ? h('small', {}, 'Also delete message') : null), h('div', {}, r.type === 'any_image' ? 'Not applicable' : `${r.threshold}`, h('small', {}, `Priority ${r.priority}`)), badge(r.approvalCurrent ? 'CURRENT' : 'REQUIRED', r.approvalCurrent ? 'green' : 'amber'), h('div', { class: 'actions wrap' }, can('rules.edit') ? button('Edit', () => editRule(r), 'quiet') : null, can('matching.test') ? button('Test', () => testRule(r), 'quiet') : null, admin() ? button('Approve', () => approveRule(r), 'quiet') : null, can('rules.delete') ? button('Delete', async () => { if (await confirmAction('Delete rule?', r.name)) {
            await api(`rules/${r.id}`, 'DELETE', { revision: r.revision });
            await render();
        } }, 'danger') : null)
    ])) : empty('No rules configured', 'Create a native text policy, image-content rule, or reference-image matching rule.')));
}
async function editRule(old?: Rule, initialContent?: import('../../shared/content.js').ContentDefinition) {
    if(old?.type==='text') return editTextRule(old);
    const floors = await api<Settings['thresholds']>('match-thresholds');
    const images = can('images.view') ? await api<ReferenceImage[]>('images') : [], groups = can('images.view') ? await api<Group[]>('groups') : [];
    const name = input(old?.name ?? ''), type = select(RULE_TYPES.map(t => [t, t === 'text' ? 'Native message text' : t === 'content' ? 'Image content analysis' : pretty(t)]), old?.type ?? (initialContent ? 'content' : 'individual')), mode = select(MODES.map(m => [m, m === 'semantic' ? 'semantic (review only)' : m]), old?.mode ?? 'exact');
    let definition = structuredClone(old?.content ?? initialContent ?? CONTENT_PRESETS[0]!.definition);
    const question = h('textarea', { rows: '3', maxlength: '1000' }), positive = h('textarea', { rows: '4', maxlength: '2000' }), negative = h('textarea', { rows: '4', maxlength: '2000' }), exceptions = h('textarea', { rows: '3', maxlength: '1000' }), contextRequirements = h('textarea', { rows: '3', maxlength: '1000' });
    const contextSource = select([['image_only', 'Image only'], ['posting_message', 'Image + posting message (server opt-in required)']], definition.contextSource);
    const promotion = check('Require visible promotion or solicitation by this post', definition.requirePromotion), readable = check('Require readable policy-relevant text', definition.requireReadableText);
    const support = h('textarea', { rows: '5', maxlength: '6000', placeholder: 'One diagnostic per line: identifier | yes/no question' });
    const fillDefinition = () => { question.value = definition.question; positive.value = definition.positive; negative.value = definition.negative; exceptions.value = definition.exceptions; contextRequirements.value = definition.contextRequirements; contextSource.value = definition.contextSource; promotion.box.checked = definition.requirePromotion; readable.box.checked = definition.requireReadableText; support.value = definition.supporting.map(s => `${s.id} | ${s.question}`).join('\n'); };
    fillDefinition();
    const searchPresets = input(''), presetChoices = select(CONTENT_PRESETS.map(p => [p.id, p.family]), definition.preset);
    searchPresets.placeholder = 'Search preset categories';
    searchPresets.oninput = () => { presetChoices.replaceChildren(...CONTENT_PRESETS.filter(p => `${p.family} ${p.definition.positive}`.toLowerCase().includes(searchPresets.value.toLowerCase())).map(p => h('option', { value: p.id }, p.family))); };
    const contentFields = h('section', { class: 'form-stack content-policy' }, h('h3', {}, 'Observable image content'), h('p', { class: 'muted' }, 'Only this selected definition runs. Templates are editable starting points, not verified classifiers. Text and imagery are assessed together; no verbatim OCR is produced.'), field('Find a preset', searchPresets), field('Preset category', presetChoices), button('Load selected template', () => { const p = CONTENT_PRESETS.find(p => p.id === presetChoices.value); if (p) { definition = structuredClone(p.definition); fillDefinition(); } }, 'quiet'), field('Yes/no question', question), field('Positive criteria', positive), field('Negative criteria and counterexamples', negative), field('Exceptions', exceptions), field('Context requirements', contextRequirements), field('Context source', contextSource), promotion.node, readable.node, field('Optional supporting predicates (diagnostic only; max 8)', support));
    const ref = select(images.map(i => [i.id, i.name]), old?.referenceId ?? images[0]?.id ?? ''), group = select(groups.map(g => [g.id, g.name]), old?.groupId ?? groups[0]?.id ?? '');
    const available = ACTIONS.filter(v => can('actions.change') ? (v !== 'kick' || can('kick.enable')) && (v !== 'ban' || can('ban.enable')) : v === (old?.action ?? 'none'));
    const action = select(available.map(v => [v, v]), old?.action ?? (available.includes('review') ? 'review' : 'none'));
    const threshold = input(String(old?.threshold ?? DEFAULT_RULE_THRESHOLD), 'number');
    threshold.min = '0.5';
    threshold.max = '1';
    threshold.step = 'any';
    const presetFor = (value: number) => value === MATCH_THRESHOLDS.standard ? 'standard' : value === MATCH_THRESHOLDS.strict ? 'strict' : 'custom';
    const matchPreset = select([['standard', 'Standard (0.70)'], ['strict', 'Strict (0.90)'], ['custom', 'Custom']], presetFor(Number(threshold.value)));
    const thresholdHelp = h('p', { class: 'muted', 'aria-live': 'polite' });
    const updateThreshold = () => {
        const anyImage = type.value === 'any_image';
        threshold.disabled = matchPreset.disabled = anyImage;
        if (anyImage) { thresholdHelp.textContent = 'Match thresholds do not apply to any-image rules. No Jev comparison is made.'; return; }
        try {
            const value = matchThreshold(Number(threshold.value));
            const floor = floors[action.value as Action];
            const effective = effectiveThreshold({ threshold: value, action: action.value as Action }, { thresholds: floors } as Settings);
            thresholdHelp.textContent = `Rule threshold ${value} · Action floor ${floor} · Effective threshold ${effective}. Score >= ${effective} meets the threshold. ${floor > value ? 'The action floor overrides the selected rule value.' : 'The rule value is at least the action floor.'}`;
        } catch { thresholdHelp.textContent = 'Enter a threshold from 0.5 to 1.0 (inclusive).'; }
    };
    matchPreset.onchange = () => { if (matchPreset.value !== 'custom') threshold.value = String(MATCH_THRESHOLDS[matchPreset.value as 'standard' | 'strict']); updateThreshold(); };
    threshold.oninput = () => { matchPreset.value = presetFor(Number(threshold.value)); updateThreshold(); };
    const timeout = input(String(old?.timeoutSeconds ?? 600), 'number');
    timeout.min = '1';
    timeout.max = '2419200';
    const presets = select([['custom', 'Custom'], ['60', '1 minute'], ['300', '5 minutes'], ['600', '10 minutes'], ['3600', '1 hour'], ['86400', '1 day'], ['604800', '7 days'], ['2419200', '28 days']], timeoutPreset(Number(timeout.value)));
    presets.onchange = () => { if (presets.value !== 'custom') timeout.value = presets.value; };
    timeout.oninput = () => { presets.value = timeoutPreset(Number(timeout.value)); };
    const priority = input(String(old?.priority ?? 0), 'number'), reason = input(old?.reason ?? 'Posted an image prohibited by this server’s image policy');
    const enabled = check('Rule enabled', old?.enabled ?? true), automatic = check('Allow automatic enforcement after approval', old?.automatic ?? false), deletion = check('Also delete the message', old?.deleteMessage ?? false), verification = check('Require a second Jev check', old?.secondVerification ?? false, 'Always required for kick and ban. The checks can share correlated errors.');
    const refField = field('Reference image', ref), groupField = field('Image group', group), timeoutField = field('Timeout duration, seconds', timeout);
    const update = () => { contentFields.hidden = type.value !== 'content'; updateThreshold(); refField.hidden = type.value !== 'individual'; groupField.hidden = type.value !== 'group'; timeoutField.hidden = action.value !== 'timeout'; presets.hidden = action.value !== 'timeout'; if (type.value === 'any_image' || type.value === 'content') {
        mode.value = 'exact';
        mode.disabled = true;
    }
    else
        mode.disabled = false; if (['none', 'review'].includes(action.value)) {
        deletion.box.checked = false;
        deletion.box.disabled = true;
    }
    else
        deletion.box.disabled = false; if (['kick', 'ban'].includes(action.value)) {
        verification.box.checked = true;
        verification.box.disabled = true;
    }
    else
        verification.box.disabled = false; };
    type.onchange = () => { if(type.value==='text') { d.close(); void editTextRule(); } else update(); };
    action.onchange = update;
    update();
    let d: HTMLDialogElement;
    d = modal(old ? 'Edit rule' : 'Create rule', 'Saving any rule edit clears its prior approval. An any-image rule requires no positive Jev match.', h('div', { class: 'form-stack' }, field('Rule name', name), h('div', { class: 'form-row' }, field('When', type), field('Matching mode', mode)), refField, groupField, contentFields, h('div', { class: 'form-row' }, field('Action', action), field('Threshold preset', matchPreset), field('Match score threshold', threshold), field('Priority', priority)), thresholdHelp, h('p', { class: 'muted' }, 'Standard and Strict are practical starting points that depend on the domain, model and images. Strict is a stricter threshold, not an accuracy guarantee. Action floors are configurable by server managers in Settings.'), presets, timeoutField, field('Moderation reason', reason), enabled.node, automatic.node, deletion.node, verification.node), [button('Save rule', async () => {
            const rule = { ...(type.value === 'content' ? { content: parseContent({ ...definition, version: CONTENT_VERSION, question: question.value, positive: positive.value, negative: negative.value, exceptions: exceptions.value, contextRequirements: contextRequirements.value, contextSource: contextSource.value, requirePromotion: promotion.box.checked, requireReadableText: readable.box.checked, supporting: support.value.trim() ? support.value.split('\n').map(line => { const split = line.indexOf('|'); return { id: line.slice(0, split).trim(), question: line.slice(split + 1).trim() }; }) : [] }) } : {}), name: name.value, type: type.value, referenceId: type.value === 'individual' ? ref.value : null, groupId: type.value === 'group' ? group.value : null, mode: mode.value, threshold: Number(threshold.value), action: action.value, timeoutSeconds: Number(timeout.value), deleteMessage: deletion.box.checked, priority: Number(priority.value), enabled: enabled.box.checked, automatic: automatic.box.checked, secondVerification: verification.box.checked, reason: reason.value };
            await api(old ? `rules/${old.id}` : 'rules', old ? 'PUT' : 'POST', { rule: parseRule(rule), ...(old ? { revision: old.revision } : {}) });
            d.close();
            await render();
        })]);
}
async function testRule(rule: Rule) {
    if(rule.type==='text') return testTextRule(rule);
    const files = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true }), expected = select([['unlabeled', 'Do not label'], ['match', 'Should match'], ['nonmatch', 'Should not match']], 'unlabeled');
    const postingContext = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'Author-supplied posting message, only when explicitly configured' });
    const source = select([['upload', 'Local files'], ['message', 'Discord message link'], ...(can('images.view') ? [['library', 'Image library'] as [string, string]] : [])], 'upload');
    const messageUrl = input(''); messageUrl.placeholder = 'https://discord.com/channels/guild/channel/message';
    const library = h('select', { multiple: true, size: '6' });
    if (can('images.view')) for (const image of await api<ReferenceImage[]>('images')) library.append(h('option', { value: image.id }, image.name));
    const uploadField = field('Sample images', files), messageField = field('Discord message link', messageUrl), libraryField = field('Library images (select one or more)', library, 'Identical references produce exact_hash results and do not count toward approval. Use content rules or non-identical references.');
    source.onchange = () => { uploadField.hidden = source.value !== 'upload'; messageField.hidden = source.value !== 'message'; libraryField.hidden = source.value !== 'library'; }; source.onchange(new Event('change'));
    const results = h('div');
    const trials = await api<Calibration[]>(`rules/${rule.id}/calibration`);
    const history = table(['Sample', 'Expected', 'Predicted', 'Probability', 'Model'], trials.slice(0, 15).map(t => [t.sampleSha256.slice(0, 10), String(t.expected), String(t.predicted), t.provenance === 'exact_hash' ? 'Exact normalized-image match' : String(t.probability), t.model ?? 'Not applicable']));
    modal('Test: ' + rule.name, 'Tests never moderate a Discord user. Use distinct representative positive and negative examples; synthetic examples alone do not establish real-world accuracy.', h('div', { class: 'form-stack' }, field('Sample source', source), uploadField, messageField, libraryField, ...(rule.type === 'content' ? [field('Posting context', postingContext), h('p', {}, rule.content?.question ?? ''), h('p', { class: 'muted' }, `Positive: ${rule.content?.positive} · Negative: ${rule.content?.negative} · Exceptions: ${rule.content?.exceptions}`)] : []), field('Expected result for these images', expected), results, h('h3', {}, 'Recent calibration samples'), history), [button('Run tests', async () => {
            const labels = { ...(rule.content?.contextSource === 'posting_message' ? { context: postingContext.value } : {}), ...(expected.value !== 'unlabeled' ? { expected: expected.value === 'match' } : {}) };
            results.replaceChildren();
            if (source.value !== 'upload') {
                const body = source.value === 'message' ? { messageUrl: messageUrl.value.trim() } : { imageIds: Array.from(library.selectedOptions).map(o => o.value) };
                const response = await api(`rules/${rule.id}/test`, 'POST', { ...body, ...labels });
                for (const [index, r] of response.results.entries()) results.append(h('article', { class: 'test-result' }, h('strong', {}, `Sample ${index + 1}: ${r.predicted ? 'MATCH' : 'NO MATCH'}`), h('p', {}, r.calibrationNote ?? 'Evaluated using the standard rule test path. No action executed.'), h('pre', { class: 'code-block' }, JSON.stringify(r, null, 2))));
                message('Tests finished. Labeled samples use the same normalized SHA-256 deduplication and cost ledger.');
                return;
            }
            if (!files.files?.length) throw new Error('Select sample images');
            for (const file of Array.from(files.files)) {
                try {
                const r = await api(`rules/${rule.id}/test`, 'POST', { base64: await base64(file), ...(rule.content?.contextSource === 'posting_message' ? { context: postingContext.value } : {}), ...(expected.value !== 'unlabeled' ? { expected: expected.value === 'match' } : {}) });
                if (r.calibrationNote) results.append(h('p', { class: 'notice' }, r.calibrationNote));
                if (rule.type === 'content') { const evidence = r.matches[0]?.content; results.append(h('article', { class: 'content-result' }, h('img', { src: await base64Preview(file), alt: 'Submitted test image', class: 'content-sample' }), h('h3', {}, evidence?.status?.replaceAll('_', ' ') ?? 'Not evaluated'), h('p', {}, `Context included: ${rule.content?.contextSource === 'posting_message' ? postingContext.value : 'Image only'}`), h('p', {}, `Depicted-content predicate: ${evidence?.depictedProbability} · Readability: ${evidence?.readability} · Post context: ${evidence?.context} · Promotion predicate: ${evidence?.promotionProbability}`), h('p', {}, `Blocked reasons: ${evidence?.blockedReasons?.join(', ') || 'none'} · Verification: ${JSON.stringify(evidence?.verification ?? 'not requested')}`), h('p', {}, `Model: ${r.matches[0]?.model} · Prompt: ${evidence?.promptVersion} · Preset: ${evidence?.definition?.preset} v${evidence?.definition?.presetVersion}`), h('p', {}, `Provider attempts: ${r.accounting?.attempts ?? 'unknown'}. Estimated cost: ${r.accounting?.estimatedCostMicros === null || !r.accounting ? 'unavailable' : money(r.accounting.estimatedCostMicros) + ' ' + r.accounting.currency}${r.accounting?.partial ? ' (partial)' : ''}. Policy outcome: ${r.policyOutcome?.action}; ${r.policyOutcome?.reason}.`), h('p', {}, `Policy eligible: ${r.predicted}. Test never executes enforcement. Intended action: ${rule.action}.`), h('pre', { class: 'code-block' }, JSON.stringify(evidence?.signals ?? {}, null, 2)))); }
                results.append(h('div', { class: 'test-result' }, h('strong', {}, file.name), badge(rule.type === 'content' ? r.matches[0]?.content?.status?.replaceAll('_', ' ').toUpperCase() ?? 'NOT EVALUATED' : r.predicted ? 'MATCH' : 'NO MATCH', r.predicted || r.matches[0]?.content?.status === 'insufficient_evidence' ? 'amber' : 'green'), h('span', {}, `${r.hashComparisons ? 'Exact normalized-image match; numerical thresholds do not apply' : r.thresholdApplies === false ? 'Any-image policy; numerical thresholds do not apply' : 'Noul probability ' + r.probability + ' / rule ' + r.ruleThreshold + ' / action floor ' + r.actionFloor + ' / effective ' + r.effectiveThreshold + ' / meets threshold: ' + r.meetsThreshold} / ${r.hashComparisons ?? 0} hash-handled comparisons / ${r.inputTokens} reported input tokens from successful responses (retry usage is in the request ledger) / No action executed`)));
                } catch (error) { results.append(h('div', { class: 'notice error' }, `${file.name}: Evaluation failed. No policy decision or punishment authorized. ${error instanceof Error ? error.message : 'Processing failure'}`)); }
            }
            message('Tests finished. Labeled examples were stored without retaining their uploaded image bytes.');
        })]);
}
function approveRule(rule: Rule) {
    const note = h('textarea', { rows: '4', placeholder: 'Describe the representative samples and false-positive risks you reviewed.' });
    const ack = check('I reviewed the evidence and accept the remaining false-positive risk.', false);
    let d: HTMLDialogElement;
    d = modal('Approve: ' + rule.name, rule.type === 'any_image' ? 'This rule applies to every supported image in selected channels, without a Jev similarity result.' : 'Kick and ban require at least 5 distinct positive and 20 distinct negative samples; other actions require at least one of each. These counts are safeguards, not statistical accuracy guarantees.', h('div', { class: 'form-stack' }, field('Approval note (at least 20 characters)', note), ack.node), [button('Approve current configuration', async () => { if (!ack.box.checked)
            throw new Error('Acknowledge the remaining risk'); await api(`rules/${rule.id}/approve`, 'POST', { note: note.value }); d.close(); await render(); })]);
}
async function logs(parent: HTMLElement) {
    const category = select([['events', 'Moderation events'], ['evaluations', 'Image evaluations'], ['audit', 'Administrative audit'], ['actions', 'Durable action ledger']], 'events'), search = input('');
    search.placeholder = 'Search IDs, actions, errors, or rules';
    const results = h('div');
    let next: string | null = null;
    async function load(before?: string) {
        const r = await api(`${category.value}?q=${encodeURIComponent(search.value)}${before ? '&before=' + encodeURIComponent(before) : ''}`);
        next = r.nextBefore;
        results.replaceChildren(h('p', { class: 'muted' }, `${r.totalRetained} retained records · up to 100 shown on this page`));
        if (!r.items.length) {
            results.append(empty('No matching records', 'Try a different search or record category.'));
            return;
        }
        results.append(table(['Time', 'Summary', 'Outcome', 'Details'], r.items.map((row: any) => [date(row.createdAt), h('div', {}, row.userId ?? row.actor ?? '', h('small', {}, row.messageId ?? row.target ?? '')), pretty(row.actual ?? row.outcome ?? row.event ?? row.status ?? ''), button('View', () => {
                const body = h('div', { class: 'form-stack' }, ...(row.matches ?? []).map((m: any) => h('p', {}, `${m.provenance === 'exact_hash' ? 'Exact normalized-image match' : m.provenance === 'any_image' ? 'Any-image policy' : m.provenance === 'text' ? 'Native text · '+m.text?.status+' · model probability '+m.probability+' · digest '+m.text?.sampleSha256?.slice(0,12) : 'Jev estimate ' + m.probability} · Reference ${m.referenceId ?? 'none'} · ${row.reason ?? row.outcome ?? ''}`)), h('pre', { class: 'code-block' }, JSON.stringify(row, null, 2)));
                const actions: HTMLElement[] = [];
                let d: HTMLDialogElement;
                if (category.value === 'events' && can('rules.edit'))
                    for (const status of ['confirmed', 'false_positive', 'dismissed'])
                        actions.push(button(pretty(status), async () => { if (status === 'false_positive' && !await confirmAction('Mark false positive?', 'This disables the associated rule and clears its approval. It does not undo an existing Discord sanction.'))
                            return; await api(`events/${row.id}/review`, 'POST', { status, revision: row.revision }); d.close(); await load(); }, status === 'false_positive' ? 'danger' : 'quiet'));
                d = modal('Event details', 'Review labels never execute a moderation action. Submitted image bytes are not retained.', body, actions);
            }, 'quiet')])));
        if (next)
            results.append(button('Next page', () => load(next!), 'quiet'));
    }
    category.onchange = () => void load().catch(fail);
    parent.append(panel('Search activity', 'All results belong to this server. Credentials and original image bytes are excluded.', h('div', { class: 'form-row' }, field('Record type', category), field('Search', search), button('Search', () => load()), can('logs.export') ? button('Export events CSV', async () => download(await blobRequest('events/export'), 'typecheck-events.csv'), 'quiet') : null), results));
    await load();
}
async function permissions(parent: HTMLElement) {
    const grants = await api<RoleGrant[]>('grants');
    const role = select(meta.roles.map(r => [r.id, r.name]), meta.roles.find(r => r.id !== guild)?.id ?? guild);
    const matrix = h('div', { class: 'permission-grid' });
    const toggles = new Map<Capability, HTMLInputElement>();
    const update = () => {
        matrix.replaceChildren();
        toggles.clear();
        const grant = grants.find(g => g.roleId === role.value);
        for (const cap of CAPABILITIES) {
            const reserved = ADMIN_ONLY.includes(cap);
            const item = check(pretty(cap), reserved ? false : grant?.capabilities.includes(cap) ?? false, reserved ? 'Server managers only' : undefined);
            item.box.disabled = reserved || !admin() && (!can(cap) || cap === 'moderators.delegate');
            toggles.set(cap, item.box);
            matrix.append(item.node);
        }
    };
    role.onchange = update;
    update();
    parent.append(h('div', { class: 'notice' }, 'The server owner and members with Administrator or Manage Server have full TypeCheck access automatically. Everyone else needs a TypeCheck role grant. Backend requests recheck current roles; hiding a control is not an authorization boundary.'));
    parent.append(panel('Delegated capabilities', 'Grant only the capabilities needed for the role. Image changes invalidate dependent approvals.', field('Discord role', role), matrix, h('div', { class: 'actions' }, button('Save role permissions', async () => { if (role.value === guild && !await confirmAction('Grant access to @everyone?', 'These capabilities will be available to every member of this Discord server.'))
        return; const old = grants.find(g => g.roleId === role.value); await api(`grants/${role.value}`, 'PUT', { revision: old?.revision ?? 0, capabilities: [...toggles].filter(([, v]) => v.checked).map(([c]) => c) }); await render(); message('Role permissions saved.'); }), button('Revoke this role’s grant', async () => { const old = grants.find(g => g.roleId === role.value); if (!old)
        throw new Error('This role has no grant'); await api(`grants/${role.value}`, 'DELETE', { revision: old.revision }); await render(); }, 'danger'))));
    parent.append(panel('Your effective permissions', `User ${authority!.userId} · ${admin() ? 'Server management access' : 'Delegated role access'}`, h('div', { class: 'cap-list' }, ...authority!.capabilities.map(c => badge(pretty(c))))));
}
function checklist(title: string, entries: {
    id: string;
    name: string;
}[], selected: string[]) { const boxes = new Map<string, HTMLInputElement>(); const node = h('div', { class: 'selector-list' }); for (const r of entries) {
    const c = check(r.name, selected.includes(r.id));
    boxes.set(r.id, c.box);
    node.append(c.node);
} return { node: field(title, node), values: () => [...boxes].filter(([, v]) => v.checked).map(([id]) => id) }; }
async function settingsPage(parent: HTMLElement) {
    settings = await api<SettingsVersion>('settings');
    const s = structuredClone(settings.value);
    const textEnabled = check('Enable native message-text analysis', s.textModerationEnabled ?? false, 'Separate from image context. Only enabled, configured text rules run. Automatic actions additionally require current text calibration approval and global enforcement.');
    parent.append(panel('Native text moderation', 'Disabled by default. Raw message text is refetched transiently and is not retained in jobs or decision evidence.', textEnabled.node));
    const contentContext = check('Allow posting-message text as labeled context for content rules', s.contentMessageContext ?? false, 'Never includes history, private messages or unrelated attachments.');
    parent.append(panel('Image content context', 'Opt-in applies only to rules configured to use the posting message.', contentContext.node));
    const channels = meta.channels.filter(c => [0, 5].includes(c.type)).map(c => ({ id: c.id, name: c.name ?? c.id }));
    const monitored = checklist('Monitored channels', channels, s.channels), excluded = checklist('Excluded channels', channels, s.excludedChannels);
    if (!admin()) {
        parent.append(panel('Channel configuration', 'Monitoring uses exact channel IDs; no channel is monitored when none is selected.', h('div', { class: 'columns' }, monitored.node, excluded.node), button('Save channels', async () => { await api('channels', 'PUT', { channels: monitored.values(), excludedChannels: excluded.values(), revision: settings!.revision }); await render(); })));
        return;
    }
    const monitoring = check('Monitor selected channels', s.monitoring), enforcement = check('Enable automatic enforcement', s.enforcement), high = check('Allow kick and ban policies', s.highImpactEnabled), any = check('Allow explicit any-image rules', s.anyImageEnabled, 'These rules do not require a Jev match.'), semantic = check('Enable semantic tests and review-only rules', s.semanticEnabled), bots = check('Inspect other bots’ image attachments', s.processBots), webhooks = check('Inspect webhook messages', s.processWebhooks, 'Webhook messages can be deleted; no user-level punishment is applied to webhook identities.'), dm = check('Send optional direct-message notifications', s.dmNotify);
    const exempt = checklist('Exempt Discord roles', meta.roles, s.exemptRoles), log = select([['', 'No log channel'], ...channels.map(c => [c.id, c.name] as [
            string,
            string
        ])], s.logChannel ?? ''), daily = input(String(s.dailyCallLimit), 'number'), retention = input(String(s.logRetentionDays), 'number'), model = input(s.model), uncertain = select([['review', 'Add uncertain matches to review'], ['ignore', 'Ignore uncertain matches']], s.uncertain);
    const thresholds = new Map<string, HTMLInputElement>();
    const thresholdGrid = h('div', { class: 'threshold-grid' });
    for (const action of ACTIONS) {
        const el = input(String(s.thresholds[action]), 'number');
        el.min = '0.5';
        el.max = '1';
        el.step = 'any';
        thresholds.set(action, el);
        thresholdGrid.append(field(action === 'review' ? 'Human-review threshold' : `${pretty(action)} action floor`, el));
    }
    parent.append(panel('Monitoring & enforcement', 'Default: no monitored channels, no automatic actions. Source images are transient and not retained.', h('div', { class: 'columns' }, h('div', { class: 'form-stack' }, monitoring.node, enforcement.node, high.node, any.node, semantic.node), h('div', { class: 'form-stack' }, bots.node, webhooks.node, dm.node, field('Uncertain result policy', uncertain))), h('div', { class: 'columns' }, monitored.node, excluded.node), exempt.node));
    parent.append(panel('Matching, usage & retention', 'Action-specific floors combine with the rule threshold. Changing model or threshold settings makes prior approvals stale. Valid range: 0.5-1.0 inclusive; timeout <= kick <= ban. Standard 0.70 and Strict 0.90 are starting points, not accuracy claims.', h('div', { class: 'form-row' }, field('Pinned Jev model', model), field('Daily request limit (UTC)', daily), field('Log retention, days', retention)), field('Moderator log channel', log), thresholdGrid,
        h('p', {}, 'Jev automation: a comparison must reach the greater of its rule threshold and action floor. Equality qualifies; approvals, verification, permissions and all execution safeguards still apply.'),
        h('p', {}, 'Jev human review: when the uncertain result policy is review and no rule qualifies for its action, comparisons at or above the human-review threshold but below their effective action threshold enter Logs as open moderation events. Below the review threshold, no fallback review is created. Ignore disables this fallback; explicit review rules still apply.'),
        h('p', {}, 'A review threshold equal to or above an effective action threshold leaves no fallback review band for that rule. Action-qualified rules take precedence. Thresholds do not guarantee an error rate. New servers default to a review threshold of 0.70; older versions used 0.5 for fallback review.'),
        h('p', {}, 'Exact normalized-image matches have no probability. Numerical bands do not apply to hash evidence; unmet execution safeguards route it to review without Jev.'),
        h('div', { class: 'actions' }, button('Save settings', async () => {
        const enabling = enforcement.box.checked && !s.enforcement;
        if (enabling && !await confirmAction('Enable automatic enforcement?', 'Only approved rules will execute. Model errors and uncertain matches do not authorize punishment. False positives remain possible.'))
            return;
        const value = { ...s, textModerationEnabled: textEnabled.box.checked, contentMessageContext: contentContext.box.checked, monitoring: monitoring.box.checked, enforcement: enforcement.box.checked, highImpactEnabled: high.box.checked, anyImageEnabled: any.box.checked, semanticEnabled: semantic.box.checked, processBots: bots.box.checked, processWebhooks: webhooks.box.checked, dmNotify: dm.box.checked, uncertain: uncertain.value, channels: monitored.values(), excludedChannels: excluded.values(), exemptRoles: exempt.values(), logChannel: log.value || null, dailyCallLimit: Number(daily.value), logRetentionDays: Number(retention.value), model: model.value, thresholds: Object.fromEntries([...thresholds].map(([a, v]) => [a, Number(v.value)])) };
        await api('settings', 'PUT', { value: parseSettings(value), revision: settings!.revision, ...(enabling ? { acknowledgement: 'ENABLE_AUTOMATIC_ENFORCEMENT' } : {}) });
        await render();
        message('Settings saved. Review any stale rule approvals.');
    }))));
    const credential = await api('credentials'), key = input('', 'password');
    key.autocomplete = 'new-password';
    parent.append(panel('Jev API credential', 'Write-only, encrypted per server. Failed replacement validation leaves the current credential unchanged.', h('div', { class: 'credential-status' }, badge(credential.status.toUpperCase(), credential.status === 'valid' ? 'green' : 'amber'), h('span', {}, credential.configured ? 'Configured · existing key cannot be displayed' : 'No credential configured'), credential.validatedAt ? h('small', {}, `Last validation: ${date(credential.validatedAt)}`) : null, credential.lastError ? h('small', { class: 'error-text' }, credential.lastError) : null), field('New or replacement API key', key), h('div', { class: 'actions' }, button('Validate & save key', async () => { try {
        await api('credentials', 'PUT', { apiKey: key.value });
        await render();
        message('Credential validated and saved.');
    }
    finally {
        key.value = '';
    } }), credential.configured ? button('Test connection', async () => { await api('credentials/test', 'POST', {}); await render(); message('Image-capable API connection validated.'); }, 'quiet') : null, credential.configured ? button('Remove credential', async () => { if (await confirmAction('Remove this server’s credential?', 'Jev-dependent rules stop evaluating. This deletes the local encrypted key; revoke the key separately in TypeSafe to invalidate it at the provider.')) {
        await api('credentials', 'DELETE', { revision: credential.revision });
        await render();
    } }, 'danger') : null)));
}
async function start(autoConnect = true) {
    clearAgentSetup();
    const config = await api('/api/config', 'GET', undefined, true);
    browserDashboardUrl=config.dashboardUrl ?? '/setup';
    if (location.pathname === '/setup') {
        app.replaceChildren();
        const server=input(new URLSearchParams(location.search).get('guild') ?? '');
        const login=async()=>{const b=await api('/api/auth/browser/start','POST',{guildId:server.value.trim()},true);location.assign(b.authorizeUrl);};
        app.append(h('main',{class:'login'},h('h1',{},'Browser-assisted setup'),h('p',{},'Sign in with Discord for this guild. Your Manage Server or Administrator permission is checked live. WebMCP support is experimental; the same manual planner works without it.'),field('Discord server ID',server),button('Sign in with Discord',login),h('a',{href:'/'},'Activity and installation help')));
        try {
            const auth=await api('/api/auth/browser/session','POST',{},true);
            guild=auth.guildId;session=auth.sessionToken;authority=auth.authority;
            meta=await api<Metadata>('meta');settings=await api<SettingsVersion>('settings');page='Agent setup';initializeAgentSetup();await render();
        } catch(e) {if (!(e instanceof HttpError && e.status===401))fail(e);}
        return;
    }
    preview = config.preview === true;
    app.replaceChildren();
    status = h('div', { class: 'notice', role: 'status' });
    status.hidden = true;
    const inDiscord = new URLSearchParams(location.search).has('frame_id');
    const showInstall = !preview && !inDiscord;
    const installUrl = new URL('https://discord.com/oauth2/authorize');
    installUrl.search = new URLSearchParams({ client_id: config.clientId, scope: 'bot applications.commands', permissions: '1374389611526', integration_type: '0' }).toString();
    app.append(h('main', { class: 'login' }, h('div', { class: 'login-brand' }, h('span', { class: 'brand-mark' }, 'J'), h('p', { class: 'eyebrow' }, 'JEV / TYPECHECK')), badge(preview ? 'OFFLINE PREVIEW' : 'EXPERIMENTAL MODERATION', 'amber'), h('h1', {}, 'Text + image moderation.\nUnder your control.'), h('p', { class: 'login-copy' }, 'Manage text policies, reference images, permissions, and credentials inside Discord. The backend bot handles continuous monitoring.'),
        h('div', { class: 'actions login-actions' },
            showInstall ? h('a', { class: 'button primary', href: installUrl.href, target: '_blank', rel: 'noopener noreferrer', 'aria-describedby': 'install-help' }, 'Add to your server') : null,
            button(preview ? 'Open read-only preview' : 'Connect in Discord', () => connect(config.clientId), showInstall ? 'quiet' : 'primary')),
        showInstall ? h('p', { class: 'install-help', id: 'install-help' }, 'Opens Discord in a new tab. You need Manage Server permission to install. Then open the TypeCheck Activity in your server; you can connect immediately using the same Manage Server permission to choose channels, add a Jev API key, and configure rules. No separate TypeCheck role is needed. Automatic moderation stays off until approved and enabled.') : null,
        status, h('p', { class: 'muted' }, 'Launch from a server Activity. Server owners and members with Administrator or Manage Server have access automatically. Other members need a TypeCheck role grant.'),
        showInstall ? h('a', { class:'button quiet', href:'/setup' }, 'Browser-assisted setup') : null,
        showInstall ? h('p', { class: 'legal-links' }, h('a', { href: '/terms' }, 'Terms of Service'), h('a', { href: '/privacy' }, 'Privacy Policy')) : null));
    if (autoConnect && new URLSearchParams(location.search).has('frame_id'))
        await connect(config.clientId);
}
void start().catch(fail);

function costSummary(report: AnalyticsReport) {
    const b = report.buckets, attempts = b.reduce((n,v)=>n+v.attempts,0), covered = b.reduce((n,v)=>n+v.covered,0);
    const currencies = new Map<string,bigint>();
    for (const v of b) if(v.currency && v.covered) currencies.set(v.currency,(currencies.get(v.currency)??0n)+BigInt(v.costMicros));
    return h('div', {},
        ...[...currencies].map(([currency,n])=>h('p',{},h('strong',{},`Estimated ${currency} ${money(n.toString())}`))),
        currencies.size>1 ? h('p',{},'Mixed currencies — totals are shown separately.') : null,
        h('p',{},`${report.partial || covered < attempts ? 'Partial estimate' : 'Estimate coverage'}: ${covered} / ${attempts} reservations have reported usage and a configured rate.`),
        b.some(v=>v.priced<v.attempts) ? h('p',{},'Rate not configured for some attempts.') : null,
        b.some(v=>v.unknownUsage) ? h('p',{},`Usage unknown: ${b.reduce((n,v)=>n+v.unknownUsage,0)}. Failed or timed-out requests may incur charges.`) : null,
        !attempts ? empty('No tracked attempts in this range','No monetary estimate is available.') : null,
        h('p',{},`${b.reduce((n,v)=>n+v.dispatched,0)} attempted dispatches · ${b.reduce((n,v)=>n+BigInt(v.inputTokens),0n)} reported input tokens`),
        h('p',{},`${b.reduce((n,v)=>n+v.successes,0)} successful · ${b.reduce((n,v)=>n+v.failures,0)} failed · ${b.reduce((n,v)=>n+v.pending,0)} pending · ${b.reduce((n,v)=>n+v.uncertain,0)} uncertain`),
        h('small',{},`Detailed tracking begins ${report.trackingStart} (UTC). Legacy aggregate: ${report.legacy.calls} reservations, ${report.legacy.inputTokens} reported tokens. These are separate, unpriced totals and have no model attribution.`));
}
function bucketTable(b: Bucket[]) { return table(['Group / currency','Reservations','Success / failure','Pending / uncertain','Reported tokens','Estimated cost','Coverage'],b.map(v=>[`${v.key} / ${v.currency??'Rate not configured'}`,v.attempts,`${v.successes} / ${v.failures}`,`${v.pending} / ${v.uncertain}`,v.inputTokens,v.currency&&v.covered?`Estimated ${v.currency} ${money(v.costMicros)}${v.covered<v.attempts?' (partial)':''}`:'Estimate unavailable',`${v.covered}/${v.attempts} priced with usage; ${v.unknownUsage} usage unknown`])); }
async function costsPage(parent: HTMLElement) {
    const range=select([['today','Today'],['7d','Last 7 days'],['30d','Last 30 days'],['mtd','Month to date'],['custom','Custom (up to 90 days)']],'7d');
    const start=input(new Date(Date.now()-6*86400000).toISOString().slice(0,10),'date'),end=input(new Date(Date.now()+86400000).toISOString().slice(0,10),'date');
    const content=h('div'), details=h('div'); let query='',cursor='';
    const loadDetails=async()=>{const page=await api<{items:Attempt[];next:{before:string;beforeId:string}|null}>('analytics/attempts?'+query+cursor);
        details.replaceChildren(panel('Attempt details','Reservations do not prove provider receipt or billing. Old pending dispatches can have uncertain outcomes.',
            page.items.length?table(['Started (UTC)','Model / purpose','Mode / retry / verification','Outcome','Tokens','Estimated cost','Correlation / attempt'],page.items.map(a=>[a.startedAt,`${a.model} / ${a.purpose}`,`${a.analysisKind === 'text' ? 'native text analysis' : a.analysisKind === 'content' ? 'image content analysis' : a.mode} / ${a.retry} / ${a.verification}`,`${a.outcome}${a.error?' / '+a.error:''}`,a.inputTokens??'Usage unknown',a.costMicros!==null?`Estimated ${a.rate!.currency} ${money(a.costMicros)}`:a.inputTokens===null?'Usage unknown':'Rate not configured',`${a.correlationId} / ${a.id}${a.ruleIds ? ' / rules ' + a.ruleIds.join(', ') : ''}`])):empty('No attempts','Choose a different date range.'),
            button('Export this page as CSV',async()=>download(await blobRequest('analytics/export?'+query+cursor),'estimated-jev-usage-page.csv'),'quiet'),
            cursor?button('First page',async()=>{cursor='';await loadDetails();},'quiet'):null,
            page.next?button('Next page',async()=>{cursor='&'+new URLSearchParams(page.next!).toString();await loadDetails();},'quiet'):null));};
    const load=async()=>{content.replaceChildren(h('p',{role:'status'},'Loading cost and usage…'));details.replaceChildren();cursor='';const p=new URLSearchParams({range:range.value,limit:'50'});if(range.value==='custom'){p.set('start',start.value);p.set('end',end.value);}query=p.toString();
        try {const [summary,daily,...groups]=await Promise.all([api<AnalyticsReport>('analytics/summary?'+query),api<AnalyticsReport>('analytics/daily?'+query),...['model','purpose','verification','outcome'].map(group=>api<AnalyticsReport>('analytics/breakdown?'+query+'&group='+group))]);
            const peak=Math.max(1,...daily.buckets.map(v=>v.attempts));
            content.replaceChildren(panel('Estimated spend & coverage','Jev input tokens only. Excludes hosting, storage, network, taxes, credits and other provider charges.',costSummary(summary)),
                panel('Daily trends (UTC)','Inclusive start, exclusive end. The table provides the same daily counts and exact estimates.',
                    h('div',{'aria-label':'Daily reservation trends'},...daily.buckets.map(v=>h('div',{class:'usage'},h('label',{},`${v.key} ${v.currency??'unpriced'}: ${v.attempts} reservations`,h('meter',{min:0,max:peak,value:v.attempts,'aria-label':`${v.key}: ${v.attempts} reservations`},String(v.attempts)))))),bucketTable(daily.buckets)),
                ...groups.map((r,i)=>panel(['By model','By purpose','By verification','By outcome'][i]!,undefined,bucketTable(r.buckets))));await loadDetails();
        } catch(e){content.replaceChildren(h('p',{role:'alert'},'Unable to load analytics. Check the UTC range and retry.'));throw e;}};
    parent.append(panel('Reporting range','Choose dates within the last 90 UTC days. End date is exclusive.',h('div',{class:'form-row'},field('Range',range),field('Start (UTC)',start),field('End (exclusive UTC)',end),button('Apply range',load))),content,details);
    await load();
    if(admin()) {
        const rates=await api<Rate[]>('analytics/pricing'),model=input(settings?.value.model??DEFAULT_SETTINGS.model),currency=input(''),price=input(''),effective=input(new Date().toISOString()),note=input('');
        const editor=panel('Server pricing','Operator-entered estimates only. Changing this configuration does not change the provider’s price or historical attempt snapshots.',
            rates.length?table(['Model','Revision','Currency','Input price per million','Effective (UTC)','Source / note'],rates.map(r=>[r.model,r.revision,r.currency,r.perMillion,r.effectiveAt,r.note])):h('p',{},'Rate not configured. No default prices are assumed.'),
            field('Model',model),field('Currency (three uppercase letters)',currency),field('Price per million input tokens (up to 6 decimals)',price),field('Effective UTC timestamp',effective),field('Rate source / note (optional)',note),
            button('Save estimated rate',async()=>{await api('analytics/pricing','PUT',{model:model.value,revision:rates.find(r=>r.model===model.value)?.revision??0,currency:currency.value,perMillion:price.value,effectiveAt:effective.value,note:note.value});await render();message('Pricing revision saved. Historical snapshots are unchanged.');}));
        parent.append(editor);
    }
}

async function base64Preview(file: File): Promise<string> { return `data:${file.type};base64,${await base64(file)}`; }


async function historicalPage(parent: HTMLElement) {
    if(!admin()) throw new Error('server_management_required');
    const scans=await api<HistoricalScan[]>('scans');
    const scope=select([['all','All eligible channels'],['selected','Selected channels']],'all');
    const selected=h('select',{multiple:true,size:8}), exclusions=h('select',{multiple:true,size:8});
    for(const c of meta.channels.filter(c=>[0,5].includes(c.type))) {
        selected.append(h('option',{value:c.id},c.name??c.id));
        exclusions.append(h('option',{value:c.id},c.name??c.id));
    }
    const from=input('','datetime-local'),to=input('','datetime-local');
    const messages=input('10000','number'),images=input('1000','number'),requests=input('1000','number');
    const body=()=>({channels:scope.value==='all'?'all':Array.from(selected.selectedOptions,o=>o.value),exclusions:Array.from(exclusions.selectedOptions,o=>o.value),from:from.value?new Date(from.value).toISOString():null,to:to.value?new Date(to.value).toISOString():null,budgets:{messages:Number(messages.value),images:Number(images.value),requests:Number(requests.value)}});
    parent.append(panel('Historical image scan','Review only. Existing messages are evaluated without deleting messages or punishing members. Threads, archived threads and forum/media posts are excluded.',
        h('div',{class:'form-stack'},field('Scope',scope),field('Selected channels (multiple selection)',selected),field('Excluded channels',exclusions),
        h('div',{class:'form-row'},field('From (optional, local time)',from),field('Before (optional, local time)',to)),
        h('div',{class:'form-row'},field('Message budget',messages),field('Image budget',images),field('Provider attempt budget',requests))),
        button('Preview scope and budgets',async()=>{
            const input=body(),plan=await api<HistoricalScan>('scans/preview','POST',input);
            let dialog: HTMLDialogElement;
            dialog=modal('Review historical scope',plan.threadCoverage,h('div',{},h('p',{},'Upper cutoff: '+plan.cutoff),h('p',{},String(plan.budgets.messages)+' messages / '+plan.budgets.images+' images / '+plan.budgets.requests+' provider attempts'),table(['Channel','Coverage','Reason'],plan.channels.map(c=>[c.name,c.status,c.reason??'Eligible']))),[button('Start review-only scan',async()=>{await api('scans','POST',{...input,to:plan.cutoff});dialog.close();await render();})]);
        })));
    parent.append(h('p',{class:'muted'},'Progress survives closing this Activity. Refresh to update. Usage and estimated costs appear in Cost & Usage under moderation; scan attempt reservations include interrupted work. Unknown usage or missing pricing is never treated as free.'));
    for(const scan of scans) {
        const c=scan.counters;
        parent.append(panel('Scan '+scan.id,pretty(scan.status),h('p',{},'Cutoff '+scan.cutoff+' · '+(scan.reason??'Review only')),
            h('p',{},scan.threadCoverage),button('Scan usage and cost',async()=>{
                const report=await api<AnalyticsReport>('analytics/summary?range=custom&start='+scan.createdAt.slice(0,10)+'&end='+new Date(Date.now()+86400000).toISOString().slice(0,10)+'&correlationId='+scan.id);
                modal('Scan usage','Provider ledger for this scan. Estimates exclude unknown usage or missing prices; reservations are not proof of dispatch.',bucketTable(report.buckets),[]);
            },'quiet'),h('p',{},c.messages+' messages · '+c.images+' images · '+c.matches+' matches · '+c.skipped+' skipped · '+c.failed+' failures · '+c.requests+' request reservations · '+c.reused+' reused results'),
            h('p',{},'Next eligible retry: '+(scan.nextAttempt<8640000000000000?new Date(scan.nextAttempt).toISOString():'Paused or terminal')),
            table(['Channel','Coverage','Reason','Before cursor'],scan.channels.map(c=>[c.name,c.status,c.reason??'',c.before])),
            scan.failures.length?table(['Channel','Message','Failure'],scan.failures.map(f=>[f.channel,f.message??'',f.reason])):null,
            h('div',{class:'actions'},...(['pause','resume','cancel'] as const).map(action=>button(pretty(action),async()=>{await api('scans/'+scan.id+'/'+action,'POST',{});await render();},action==='cancel'?'danger':'quiet')))));
    }
}

function textStarterPanel() {
    const choice = select(TEXT_STARTERS.map(s => [s.id, s.name]), TEXT_STARTERS[0]!.id), preview = h('div', { class: 'text-starter-preview', 'aria-live': 'polite' });
    const show = () => { const s = TEXT_STARTERS.find(s => s.id === choice.value)!; preview.replaceChildren(h('p', { class: 'eyebrow' }, `TEXT / ${s.id} / v${s.version} / SYNTHETIC`), h('h3', {}, s.definition.question), h('p', {}, s.definition.positive), h('p', {}, `Exclusions: ${s.definition.negative}`), ...Object.entries(s.examples).map(([label, value]) => h('p', {}, h('strong', {}, label + ': '), value)), ...(s.requiresConfiguration ? [h('p', { class: 'notice' }, 'Concrete community configuration is required before enabling or approval.')] : [])); };
    choice.onchange = show;
    show();
    return panel('Text starter policies', 'Ten editable plain-text templates. Separate synthetic examples; no reviewed-image provenance or automatic enforcement.', field('Preview a text starter', choice), preview, h('div', { class: 'actions wrap' }, admin() && can('rules.create') ? button('Customize selected starter', () => editTextRule(undefined, choice.value), 'quiet') : null, admin() ? button('Install all disabled text starters', async () => { if (await confirmAction('Install disabled text starters?', 'Adds ten review-only rules once for this server. Existing rules remain unchanged. Deleted starters stay deleted. No approval is granted.')) {
        const result = await api('text-starters/install', 'POST', {});
        message(`${result.installed} disabled starters installed${result.alreadyInstalled ? ' (already installed; no changes)' : ''}.`);
        await render();
    } }, 'quiet') : null));
}
async function editTextRule(old?: Rule, starterId = TEXT_STARTERS[0]!.id) {
    const starter = TEXT_STARTERS.find(s => s.id === starterId)!, definition = structuredClone(old?.text ?? starter.definition);
    const name = input(old?.name ?? starter.name), question = h('textarea', { rows: '3', maxlength: '1000' }), positive = h('textarea', { rows: '4', maxlength: '2000' }), negative = h('textarea', { rows: '3', maxlength: '2000' }), exceptions = h('textarea', { rows: '3', maxlength: '1000' }), context = h('textarea', { rows: '3', maxlength: '1000' });
    question.value = definition.question;
    positive.value = definition.positive;
    negative.value = definition.negative;
    exceptions.value = definition.exceptions;
    context.value = definition.contextRequirements;
    const configured = check('I have supplied concrete observable criteria and all required community context', definition.configured), promotion = check('Require solicitation or endorsement by the posting author', definition.requirePromotion), enabled = check('Enable this text rule', old?.enabled ?? false), automatic = check('Allow automatic enforcement after text calibration and approval', old?.automatic ?? false), verification = check('Require second verification', old?.secondVerification ?? true), deletion = check('Also delete message', old?.deleteMessage ?? false);
    const action = select(ACTIONS.map(a => [a, a]), old?.action ?? 'review'), threshold = input(String(old?.threshold ?? .9), 'number'), priority = input(String(old?.priority ?? 0), 'number'), timeout = input(String(old?.timeoutSeconds ?? 600), 'number'), reason = input(old?.reason ?? 'Configured community text policy');
    threshold.min = '.5';
    threshold.max = '1';
    threshold.step = 'any';
    timeout.min = '1';
    timeout.max = '2419200';
    priority.min = '-1000';
    priority.max = '1000';
    const d = modal(old ? 'Edit native text rule' : 'Create native text rule', 'Plain Discord message text. No image, OCR, linked website or history is used. Saving clears approval. Templates and probabilities do not prove wrongdoing.', h('div', { class: 'form-stack' }, field('Rule name', name), field('Observable yes/no predicate', question), field('Positive inclusion criteria', positive), field('Exclusions and legitimate lookalikes', negative), field('Exceptions', exceptions), field('Required context available within this message', context), configured.node, promotion.node, h('div', { class: 'form-row' }, field('Action', action), field('Text threshold', threshold), field('Priority', priority)), field('Timeout seconds', timeout), field('Moderation reason', reason), enabled.node, automatic.node, verification.node, deletion.node), [button('Save text rule', async () => {
            const text = parseText({ ...definition, question: question.value, positive: positive.value, negative: negative.value, exceptions: exceptions.value, contextRequirements: context.value, configured: configured.box.checked, requirePromotion: promotion.box.checked });
            const rule = parseRule({ name: name.value, type: 'text', text, referenceId: null, groupId: null, mode: 'exact', threshold: Number(threshold.value), action: action.value, timeoutSeconds: Number(timeout.value), deleteMessage: deletion.box.checked, priority: Number(priority.value), enabled: enabled.box.checked, automatic: automatic.box.checked, secondVerification: verification.box.checked, reason: reason.value });
            await api(old ? `rules/${old.id}` : 'rules', old ? 'PUT' : 'POST', { rule, ...(old ? { revision: old.revision } : {}) });
            d.close();
            await render();
        })]);
}
async function testTextRule(rule: Rule) {
    const submitted = h('textarea', { rows: '7', placeholder: 'Paste the complete message; preserve quotations, Markdown and code blocks.' }), url = input(''), source = select([['paste', 'Pasted message text'], ['message', 'Authorized same-guild message link']], 'paste'), expected = select([['unlabeled', 'Unlabeled / ambiguous'], ['positive', 'Should detect'], ['negative', 'Should not detect']], 'unlabeled'), results = h('div', { 'aria-live': 'polite' });
    url.placeholder = 'https://discord.com/channels/guild/channel/message';
    const pasteField = field('Complete message text', submitted, `Up to ${TEXT_LIMITS.characters} UTF-16 code units and ${TEXT_LIMITS.bytes} UTF-8 bytes. No silent truncation. Empty or unavailable text requires review.`), linkField = field('Discord message link', url);
    const update = () => { pasteField.hidden = source.value !== 'paste'; linkField.hidden = source.value !== 'message'; };
    source.onchange = update;
    update();
    const history = await api<Calibration[]>(`rules/${rule.id}/calibration`);
    modal('Test native text: ' + rule.name, 'Tests never moderate users or delete messages. Submitted text is transient; only digests, labels and structured results are retained.', h('div', { class: 'form-stack' }, h('p', {}, rule.text?.question ?? ''), field('Text sample source', source), pasteField, linkField, field('Expected label', expected), results, h('h3', {}, 'Previous text calibration'), table(['Digest', 'Expected', 'Detected', 'Model'], history.map(t => [t.sampleSha256.slice(0, 12), String(t.expected), String(t.predicted), t.model ?? 'none']))), [button('Analyze text', async () => {
            results.replaceChildren(h('p', { role: 'status' }, 'Analyzing text…'));
            try {
                const r = await api(`rules/${rule.id}/test`, 'POST', { ...(source.value === 'paste' ? { text: submitted.value } : { messageUrl: url.value.trim() }), ...(expected.value === 'unlabeled' ? {} : { expected: expected.value === 'positive' }) });
                const e = r.matches[0]?.text;
                results.replaceChildren(h('article', { class: 'test-result' }, h('h3', {}, String(r.status).replaceAll('_', ' ')), h('p', {}, `Model probability ${r.probability ?? 'unavailable (no result)'} · rule threshold ${r.ruleThreshold} · action floor ${r.actionFloor} · effective ${r.effectiveThreshold}`), h('p', {}, `Context: ${e?.context}. Verification: ${r.verification ? JSON.stringify(r.verification) : 'not performed'}. Expected: ${r.expected ?? 'unlabeled / ambiguous'}.`), h('p', {}, `Policy outcome: ${r.policyOutcome?.action} / ${r.policyOutcome?.reason}. No action executed.`), h('p', {}, `Input tokens from successful responses: ${r.inputTokens}. All attempts and estimated costs appear in Cost & Usage under native text analysis.`), h('p', {}, `Evidence digest: ${e?.sampleSha256}. Prompt: ${e?.promptVersion}. Blocked: ${e?.blockedReasons?.join(', ') || 'none'}.`)));
                submitted.value = '';
            }
            catch (e) {
                results.replaceChildren(h('p', { role: 'alert' }, 'Text analysis failed; no safe classification or punishment is authorized.'));
                throw e;
            }
        })]);
}
