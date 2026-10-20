/** The Discord fields needed to reproduce the server's channel list. */
export interface ChannelMetadata {
    id: string;
    name?: string;
    type: number;
    parent_id?: string | null;
    position?: number;
}

export interface ChannelGroup {
    id: string | null;
    name: string;
    channels: ChannelMetadata[];
}

function byPosition(a: ChannelMetadata, b: ChannelMetadata): number {
    const position = (channel: ChannelMetadata) => typeof channel.position === 'number' && Number.isFinite(channel.position) ? channel.position : Number.MAX_SAFE_INTEGER;
    const difference = position(a) - position(b);
    if (difference) return difference;
    // Discord breaks position ties by snowflake ID, which exceeds Number's safe range.
    // https://docs.discord.com/developers/resources/channel#channel-object
    if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
        const first = BigInt(a.id), second = BigInt(b.id);
        return first < second ? -1 : first > second ? 1 : 0;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Group supported text/announcement channels without making categories selectable. */
export function orderedChannelGroups(channels: readonly ChannelMetadata[]): ChannelGroup[] {
    const categories = channels.filter(channel => channel.type === 4).sort(byPosition);
    const groups = new Map(categories.map(category => [category.id, {
        id: category.id,
        name: category.name || 'Unnamed category',
        channels: [] as ChannelMetadata[]
    }]));
    const uncategorized: ChannelGroup = { id: null, name: 'Uncategorized', channels: [] };
    for (const channel of channels) {
        if (channel.type !== 0 && channel.type !== 5) continue;
        // An absent/deleted parent must not hide a selectable channel.
        const group = channel.parent_id ? groups.get(channel.parent_id) : undefined;
        (group ?? uncategorized).channels.push(channel);
    }
    return [uncategorized, ...groups.values()].filter(group => group.channels.length > 0).map(group => ({
        ...group,
        channels: group.channels.sort(byPosition)
    }));
}
