import { ACTIONS, MODES, RULE_TYPES, CAPABILITIES, ADMIN_ONLY, DEFAULT_SETTINGS, type Authority, type Capability, type Group, type ReferenceImage, type Rule, type Settings, type RoleGrant, type ModerationEvent, type Calibration } from '../../shared/domain.js';
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
const can = (cap: Capability) => authority?.capabilities.includes(cap) ?? false;
const admin = () => !!(authority?.owner || authority?.administrator);
const pretty = (s: string) => s.replaceAll('_', ' ').replaceAll('.', ' / ');
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
    b.addEventListener('click', () => { b.disabled = true; Promise.resolve().then(run).catch(fail).finally(() => { b.disabled = false; }); });
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
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 401)
            session = '';
        throw new Error(data.error ?? 'Request failed');
    }
    return data as T;
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
        ['Overview', can('dashboard.view')], ['Image library', can('images.view') || can('images.add')], ['Rules & tests', can('rules.view') || can('rules.create')],
        ['Activity log', can('logs.view')], ['Permissions', admin() || can('moderators.delegate')], ['Settings', admin() || can('channels.configure')]
    ] as const;
}
async function connect(clientId: string) {
    message('Connecting to Discord…');
    const modulePath = '/vendor/discord-sdk.js';
    const { DiscordSDK } = await import(modulePath);
    sdk ??= new DiscordSDK(clientId) as SDK;
    await Promise.race([sdk.ready(), new Promise((_, reject) => setTimeout(() => reject(new Error('Open this application as a Discord Activity')), 12000))]);
    if (!sdk.guildId)
        throw new Error('Launch this Activity in a Discord server, not a direct message');
    guild = sdk.guildId;
    const { nonce } = await api('/api/auth/start', 'POST', {}, true);
    const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: nonce, prompt: 'none', scope: ['identify'] });
    const auth = await api('/api/auth/exchange', 'POST', { code, nonce, guildId: guild }, true);
    await sdk.commands.authenticate({ access_token: auth.accessToken });
    auth.accessToken = '';
    session = auth.sessionToken;
    authority = auth.authority;
    meta = await api<Metadata>('meta');
    if (can('dashboard.view') || admin() || can('channels.configure'))
        settings = await api<SettingsVersion>('settings');
    const first = links().find(([, allowed]) => allowed);
    page = first?.[0] ?? 'Overview';
    await render();
}
async function render() {
    app.replaceChildren();
    const nav = h('nav', { 'aria-label': 'Administration', class: 'nav' });
    for (const [label, allowed] of links())
        if (allowed)
            nav.append(button(label, async () => { page = label; await render(); }, label === page ? 'nav-active' : 'nav-item'));
    const aside = h('aside', { class: 'sidebar' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'J'), h('div', {}, h('strong', {}, 'TYPECHECK'), h('small', {}, 'Powered by Jev'))), h('p', { class: 'nav-label' }, 'ADMINISTRATION'), nav, h('div', { class: 'sidebar-footer' }, badge(preview ? 'OFFLINE PREVIEW' : 'EXPERIMENTAL', 'amber'), h('p', {}, 'Image-only moderation'), h('small', {}, 'v0.1.0 · Server-scoped access')));
    status = h('div', { class: 'notice', role: 'status' });
    status.hidden = true;
    const enforcement = settings?.value.enforcement;
    const header = h('header', { class: 'topbar' }, h('div', {}, h('p', { class: 'eyebrow' }, 'DISCORD ACTIVITY'), h('strong', {}, meta.name)), h('div', { class: 'actions' }, badge(enforcement ? 'ENFORCEMENT ON' : 'MONITOR ONLY', enforcement ? 'green' : 'amber'), button('Refresh', () => render(), 'quiet'), button('Reconnect', async () => { session = ''; await start(); }, 'quiet'), can('enforcement.pause') ? button('Pause enforcement', async () => { await api('pause', 'POST', {}); if (settings)
        settings.value.enforcement = false; await render(); message('Automatic enforcement paused. Requests already in flight may still finish.'); }, 'danger') : null));
    const content = h('main', { class: 'content' }, h('div', { class: 'page-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'CONTROL PANEL'), h('h1', {}, page)), badge('GUILD ' + guild)), status);
    if (preview)
        content.append(frame('div', 'preview-banner', 'OFFLINE, READ-ONLY PREVIEW', h('p', {}, 'sample data only. No Discord or Jev requests are performed.')));
    app.append(h('div', { class: 'shell' }, aside, h('div', { class: 'workspace' }, header, content)));
    const loading = h('div', { class: 'loading' }, 'Loading…');
    content.append(loading);
    try {
        authority = await api<Authority>('me');
        if (page === 'Overview')
            await overview(content);
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
    const counts = data.counts;
    parent.append(h('div', { class: 'stats' }, ...[[counts.images, 'Active reference images'], [counts.rules, 'Active rules'], [counts.evaluations, 'Retained evaluations'], [counts.successful, 'Events with successful actions']].map(([n, label]) => h('section', { class: 'stat' }, h('strong', {}, n), h('span', {}, label)))));
    const setup = h('div', { class: 'checklist' }, ...[[data.credential.configured, 'Configure a Jev key'], [counts.images > 0, 'Upload reference images'], [counts.rules > 0, 'Create and test a rule'], [settings!.value.channels.length > 0, 'Choose monitored channels'], [settings!.value.enforcement, 'Enable enforcement after approval']].map(([done, label]) => h('div', { class: 'checklist-row' }, badge(done ? 'DONE' : 'NEXT', done ? 'green' : 'neutral'), h('span', {}, label))));
    parent.append(h('div', { class: 'columns' }, panel('Setup checklist', 'New servers begin with no channels selected and enforcement off.', setup), panel('Usage & safeguards', 'A probability threshold is not an accuracy guarantee.', h('div', { class: 'usage' }, h('strong', {}, `${data.usage.calls} / ${settings!.value.dailyCallLimit}`), h('span', {}, 'Jev requests today (UTC)'), h('progress', { value: data.usage.calls, max: settings!.value.dailyCallLimit }), h('p', {}, `${Number(data.usage.inputTokens).toLocaleString()} reported input tokens`)), h('p', { class: 'muted' }, 'Kick and ban require representative labeled examples, administrator approval, and a second Jev check.'))));
    parent.append(panel('Recent moderation events', 'Outcomes are recorded separately from intended actions.', data.recent.length ? eventTable(data.recent) : empty('No moderation events', 'Upload and test a reference rule to begin. Text-only messages are ignored.')));
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
    parent.append(h('div', { class: 'notice' }, 'Default precedence: individual image → group → any matched reference → any image. Higher numeric priority overrides this order. One user-level sanction per message.'));
    if (can('rules.create'))
        parent.append(h('div', { class: 'actions section-actions' }, button('Create rule', () => editRule())));
    parent.append(panel('Moderation rules', 'Rules do not run automatically until their current configuration is approved and enforcement is enabled.', rules.length ? table(['Rule', 'Trigger', 'Action', 'Threshold / priority', 'Approval', 'Manage'], rules.map(r => [
        h('div', {}, h('strong', {}, r.name), h('small', {}, r.enabled ? 'Enabled' : 'Disabled')), h('div', {}, pretty(r.type), h('small', {}, r.type === 'any_image' ? 'No Jev comparison' : r.mode)), h('div', {}, badge(r.action), r.deleteMessage ? h('small', {}, 'Also delete message') : null), h('div', {}, `${r.threshold}`, h('small', {}, `Priority ${r.priority}`)), badge(r.approvalCurrent ? 'CURRENT' : 'REQUIRED', r.approvalCurrent ? 'green' : 'amber'), h('div', { class: 'actions wrap' }, can('rules.edit') ? button('Edit', () => editRule(r), 'quiet') : null, can('matching.test') ? button('Test', () => testRule(r), 'quiet') : null, admin() ? button('Approve', () => approveRule(r), 'quiet') : null, can('rules.delete') ? button('Delete', async () => { if (await confirmAction('Delete rule?', r.name)) {
            await api(`rules/${r.id}`, 'DELETE', { revision: r.revision });
            await render();
        } }, 'danger') : null)
    ])) : empty('No rules configured', 'Create a rule that connects an image, image group, or matching library to a moderation action.')));
}
async function editRule(old?: Rule) {
    const images = can('images.view') ? await api<ReferenceImage[]>('images') : [], groups = can('images.view') ? await api<Group[]>('groups') : [];
    const name = input(old?.name ?? ''), type = select(RULE_TYPES.map(t => [t, pretty(t)]), old?.type ?? 'individual'), mode = select(MODES.map(m => [m, m === 'semantic' ? 'semantic (review only)' : m]), old?.mode ?? 'exact');
    const ref = select(images.map(i => [i.id, i.name]), old?.referenceId ?? images[0]?.id ?? ''), group = select(groups.map(g => [g.id, g.name]), old?.groupId ?? groups[0]?.id ?? '');
    const available = ACTIONS.filter(v => can('actions.change') ? (v !== 'kick' || can('kick.enable')) && (v !== 'ban' || can('ban.enable')) : v === (old?.action ?? 'none'));
    const action = select(available.map(v => [v, v]), old?.action ?? (available.includes('review') ? 'review' : 'none'));
    const threshold = input(String(old?.threshold ?? 0.99), 'number');
    threshold.min = '0.5';
    threshold.max = '1';
    threshold.step = '0.001';
    const timeout = input(String(old?.timeoutSeconds ?? 600), 'number');
    timeout.min = '1';
    timeout.max = '2419200';
    const presets = select([['60', '1 minute'], ['300', '5 minutes'], ['600', '10 minutes'], ['3600', '1 hour'], ['86400', '1 day'], ['604800', '7 days'], ['2419200', '28 days']], String(old?.timeoutSeconds ?? 600));
    presets.onchange = () => { timeout.value = presets.value; };
    const priority = input(String(old?.priority ?? 0), 'number'), reason = input(old?.reason ?? 'Posted an image prohibited by this server’s image policy');
    const enabled = check('Rule enabled', old?.enabled ?? true), automatic = check('Allow automatic enforcement after approval', old?.automatic ?? false), deletion = check('Also delete the message', old?.deleteMessage ?? false), verification = check('Require a second Jev check', old?.secondVerification ?? false, 'Always required for kick and ban. The checks can share correlated errors.');
    const refField = field('Reference image', ref), groupField = field('Image group', group), timeoutField = field('Timeout duration, seconds', timeout);
    const update = () => { refField.hidden = type.value !== 'individual'; groupField.hidden = type.value !== 'group'; timeoutField.hidden = action.value !== 'timeout'; presets.hidden = action.value !== 'timeout'; if (type.value === 'any_image') {
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
    type.onchange = update;
    action.onchange = update;
    update();
    let d: HTMLDialogElement;
    d = modal(old ? 'Edit rule' : 'Create rule', 'Saving any rule edit clears its prior approval. An any-image rule requires no positive Jev match.', h('div', { class: 'form-stack' }, field('Rule name', name), h('div', { class: 'form-row' }, field('When', type), field('Matching mode', mode)), refField, groupField, h('div', { class: 'form-row' }, field('Action', action), field('Match probability threshold', threshold), field('Priority', priority)), presets, timeoutField, field('Moderation reason', reason), enabled.node, automatic.node, deletion.node, verification.node), [button('Save rule', async () => {
            const rule = { name: name.value, type: type.value, referenceId: type.value === 'individual' ? ref.value : null, groupId: type.value === 'group' ? group.value : null, mode: mode.value, threshold: Number(threshold.value), action: action.value, timeoutSeconds: Number(timeout.value), deleteMessage: deletion.box.checked, priority: Number(priority.value), enabled: enabled.box.checked, automatic: automatic.box.checked, secondVerification: verification.box.checked, reason: reason.value };
            await api(old ? `rules/${old.id}` : 'rules', old ? 'PUT' : 'POST', { rule, ...(old ? { revision: old.revision } : {}) });
            d.close();
            await render();
        })]);
}
async function testRule(rule: Rule) {
    const files = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true }), expected = select([['unlabeled', 'Do not label'], ['match', 'Should match'], ['nonmatch', 'Should not match']], 'unlabeled');
    const results = h('div');
    const trials = await api<Calibration[]>(`rules/${rule.id}/calibration`);
    const history = table(['Sample', 'Expected', 'Predicted', 'Probability', 'Model'], trials.slice(0, 15).map(t => [t.sampleSha256.slice(0, 10), String(t.expected), String(t.predicted), String(t.probability), t.model]));
    modal('Test: ' + rule.name, 'Tests never moderate a Discord user. Use distinct representative positive and negative examples; synthetic examples alone do not establish real-world accuracy.', h('div', { class: 'form-stack' }, field('Sample images', files), field('Expected result for these images', expected), results, h('h3', {}, 'Recent calibration samples'), history), [button('Run tests', async () => {
            if (!files.files?.length)
                throw new Error('Select sample images');
            results.replaceChildren();
            for (const file of Array.from(files.files)) {
                const r = await api(`rules/${rule.id}/test`, 'POST', { base64: await base64(file), ...(expected.value !== 'unlabeled' ? { expected: expected.value === 'match' } : {}) });
                results.append(h('div', { class: 'test-result' }, h('strong', {}, file.name), badge(r.predicted ? 'MATCH' : 'NO MATCH', r.predicted ? 'amber' : 'green'), h('span', {}, `Probability ${r.probability} · ${r.inputTokens} input tokens · No action executed`)));
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
                const body = h('div', { class: 'form-stack' }, h('pre', { class: 'code-block' }, JSON.stringify(row, null, 2)));
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
            const item = check(pretty(cap), reserved ? false : grant?.capabilities.includes(cap) ?? false, reserved ? 'Administrator only' : undefined);
            item.box.disabled = reserved || !admin() && (!can(cap) || cap === 'moderators.delegate');
            toggles.set(cap, item.box);
            matrix.append(item.node);
        }
    };
    role.onchange = update;
    update();
    parent.append(h('div', { class: 'notice' }, 'The server owner and Discord Administrators always have full access. Everyone else needs an explicit role grant. Backend requests recheck current roles; hiding a control is not an authorization boundary.'));
    parent.append(panel('Delegated capabilities', 'Grant only the capabilities needed for the role. Image changes invalidate dependent approvals.', field('Discord role', role), matrix, h('div', { class: 'actions' }, button('Save role permissions', async () => { if (role.value === guild && !await confirmAction('Grant access to @everyone?', 'These capabilities will be available to every member of this Discord server.'))
        return; const old = grants.find(g => g.roleId === role.value); await api(`grants/${role.value}`, 'PUT', { revision: old?.revision ?? 0, capabilities: [...toggles].filter(([, v]) => v.checked).map(([c]) => c) }); await render(); message('Role permissions saved.'); }), button('Revoke this role’s grant', async () => { const old = grants.find(g => g.roleId === role.value); if (!old)
        throw new Error('This role has no grant'); await api(`grants/${role.value}`, 'DELETE', { revision: old.revision }); await render(); }, 'danger'))));
    parent.append(panel('Your effective permissions', `User ${authority!.userId} · ${admin() ? 'Discord administrator' : 'Delegated role access'}`, h('div', { class: 'cap-list' }, ...authority!.capabilities.map(c => badge(pretty(c))))));
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
    const channels = meta.channels.filter(c => [0, 5].includes(c.type)).map(c => ({ id: c.id, name: c.name ?? c.id }));
    const monitored = checklist('Monitored channels', channels, s.channels), excluded = checklist('Excluded channels', channels, s.excludedChannels);
    if (!admin()) {
        parent.append(panel('Channel configuration', 'Monitoring uses exact channel IDs; no channel is monitored when none is selected.', h('div', { class: 'columns' }, monitored.node, excluded.node), button('Save channels', async () => { await api('channels', 'PUT', { channels: monitored.values(), excludedChannels: excluded.values(), revision: settings!.revision }); await render(); })));
        return;
    }
    const monitoring = check('Monitor selected channels', s.monitoring), enforcement = check('Enable automatic enforcement', s.enforcement), high = check('Allow kick and ban policies', s.highImpactEnabled), any = check('Allow explicit any-image rules', s.anyImageEnabled, 'These rules do not require a Jev match.'), semantic = check('Enable semantic tests and review-only rules', s.semanticEnabled), bots = check('Inspect other bots’ image attachments', s.processBots), webhooks = check('Inspect webhook image attachments', s.processWebhooks, 'Webhook messages can be deleted; no user-level punishment is applied to webhook identities.'), dm = check('Send optional direct-message notifications', s.dmNotify);
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
        el.step = '0.001';
        thresholds.set(action, el);
        thresholdGrid.append(field(action === 'review' ? 'Human-review threshold' : `${pretty(action)} action floor`, el));
    }
    parent.append(panel('Monitoring & enforcement', 'Default: no monitored channels, no automatic actions. Source images are transient and not retained.', h('div', { class: 'columns' }, h('div', { class: 'form-stack' }, monitoring.node, enforcement.node, high.node, any.node, semantic.node), h('div', { class: 'form-stack' }, bots.node, webhooks.node, dm.node, field('Uncertain result policy', uncertain))), h('div', { class: 'columns' }, monitored.node, excluded.node), exempt.node));
    parent.append(panel('Matching, usage & retention', 'Action-specific floors combine with the rule threshold. Changing model or threshold settings makes prior approvals stale.', h('div', { class: 'form-row' }, field('Pinned Jev model', model), field('Daily request limit (UTC)', daily), field('Log retention, days', retention)), field('Moderator log channel', log), thresholdGrid,
        h('p', {}, 'Automation: a comparison must reach the greater of its rule threshold and action floor. Equality qualifies; approvals, verification, permissions and all execution safeguards still apply.'),
        h('p', {}, 'Human review: when the uncertain result policy is review and no rule qualifies for its action, comparisons at or above the human-review threshold but below their effective action threshold enter Logs as open moderation events. Below the review threshold, no fallback review is created. Ignore disables this fallback; explicit review rules still apply.'),
        h('p', {}, 'A review threshold equal to or above an effective action threshold leaves no fallback review band for that rule. Action-qualified rules take precedence. Thresholds do not guarantee an error rate. The default review threshold is 0.8; older versions used 0.5 for fallback review.'),
        h('div', { class: 'actions' }, button('Save settings', async () => {
        const enabling = enforcement.box.checked && !s.enforcement;
        if (enabling && !await confirmAction('Enable automatic enforcement?', 'Only approved rules will execute. Model errors and uncertain matches do not authorize punishment. False positives remain possible.'))
            return;
        const value = { ...s, monitoring: monitoring.box.checked, enforcement: enforcement.box.checked, highImpactEnabled: high.box.checked, anyImageEnabled: any.box.checked, semanticEnabled: semantic.box.checked, processBots: bots.box.checked, processWebhooks: webhooks.box.checked, dmNotify: dm.box.checked, uncertain: uncertain.value, channels: monitored.values(), excludedChannels: excluded.values(), exemptRoles: exempt.values(), logChannel: log.value || null, dailyCallLimit: Number(daily.value), logRetentionDays: Number(retention.value), model: model.value, thresholds: Object.fromEntries([...thresholds].map(([a, v]) => [a, Number(v.value)])) };
        await api('settings', 'PUT', { value, revision: settings!.revision, ...(enabling ? { acknowledgement: 'ENABLE_AUTOMATIC_ENFORCEMENT' } : {}) });
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
async function start() {
    const config = await api('/api/config', 'GET', undefined, true);
    preview = config.preview === true;
    app.replaceChildren();
    status = h('div', { class: 'notice', role: 'status' });
    status.hidden = true;
    app.append(h('main', { class: 'login' }, h('div', { class: 'login-brand' }, h('span', { class: 'brand-mark' }, 'J'), h('p', { class: 'eyebrow' }, 'JEV / TYPECHECK')), badge(preview ? 'OFFLINE PREVIEW' : 'EXPERIMENTAL IMAGE MATCHING', 'amber'), h('h1', {}, 'Image moderation.\nUnder your control.'), h('p', { class: 'login-copy' }, 'Manage reference images, rules, permissions, and credentials inside Discord. The backend bot handles continuous monitoring.'), button(preview ? 'Open read-only preview' : 'Connect in Discord', () => connect(config.clientId)), status, h('p', { class: 'muted' }, 'Launch from a server Activity. Administrators have access automatically; moderators require an explicit role grant.')));
    if (new URLSearchParams(location.search).has('frame_id'))
        await connect(config.clientId);
}
void start().catch(fail);
