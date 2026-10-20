import { orderedChannelGroups, type ChannelMetadata } from '../../shared/channels.js';

export interface RoleMetadata { id: string; name: string; position?: number }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}

function option(value: string, name: string) {
    const node = element('option', name);
    node.value = value;
    return node;
}

function channelOptions(channels: readonly ChannelMetadata[]) {
    const select = element('select');
    for (const group of orderedChannelGroups(channels)) {
        const section = element('optgroup');
        section.label = group.name;
        for (const channel of group.channels) section.append(option(channel.id, channel.name || 'Unnamed channel'));
        select.append(section);
    }
    return select;
}

function multipleField(title: string, input: HTMLSelectElement, selected: readonly string[], onChange?: (values: string[]) => void) {
    const node = element('label', '', 'field channel-picker');
    node.append(element('span', title, 'field-label'), input);
    input.multiple = true;
    input.size = 8;
    for (const item of input.options) item.selected = selected.includes(item.value);
    const values = () => [...input.selectedOptions].filter(item => !item.disabled).map(item => item.value);
    input.addEventListener('change', () => onChange?.(values()));
    return { node, input, values };
}

/** Category headings are optgroups; only text and announcement channels are selectable. */
export function channelMultiSelect(title: string, channels: readonly ChannelMetadata[], selected: readonly string[] = [], onChange?: (values: string[]) => void) {
    const input = channelOptions(channels);
    const available = new Set([...input.options].map(item => item.value));
    const unavailable = selected.filter(id => !available.has(id));
    // A refresh must not silently erase a saved selection if Discord no longer returns it.
    if (unavailable.length) {
        const section = element('optgroup');
        section.label = 'Unavailable channels';
        for (const id of unavailable) section.append(option(id, `Unavailable channel (${id})`));
        input.append(section);
    }
    if (!input.options.length) {
        const empty = option('', 'No text or announcement channels are available.');
        empty.disabled = true;
        input.append(empty);
        input.disabled = true;
    }
    return multipleField(title, input, selected, onChange);
}

export function roleMultiSelect(title: string, roles: readonly RoleMetadata[], selected: readonly string[] = [], onChange?: (values: string[]) => void) {
    const input = element('select');
    for (const role of [...roles].sort((a, b) => (b.position ?? 0) - (a.position ?? 0))) input.append(option(role.id, role.name));
    for (const id of selected.filter(id => !roles.some(role => role.id === id))) input.append(option(id, `Unavailable role (${id})`));
    if (!input.options.length) {
        const empty = option('', 'No roles are available.');
        empty.disabled = true;
        input.append(empty);
        input.disabled = true;
    }
    return multipleField(title, input, selected, onChange);
}

export function channelSelect(channels: readonly ChannelMetadata[], selected = '', emptyLabel = 'No log channel') {
    const select = channelOptions(channels);
    select.prepend(option('', emptyLabel));
    if (selected && ![...select.options].some(item => item.value === selected)) select.append(option(selected, `Unavailable channel (${selected})`));
    select.value = selected;
    return select;
}
