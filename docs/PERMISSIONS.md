# Roles and capabilities

The guild owner and members with Discord **Administrator or Manage Server** receive all TypeCheck management capabilities automatically. This matches the Discord permission needed to install a server app: install, launch the Activity or browser setup, and connect without creating a TypeCheck role first. All other members begin with none, regardless of role name. Multiple role grants combine additively; per-role deny overrides are not implemented. Backend requests always refresh Discord authority. Losing Manage Server immediately removes this automatic access on the next request; separately granted capabilities still apply. The `administrator` response field continues to mean Discord Administrator; `manageGuild` reports Manage Server. No Discord role is created or assigned, and the bot needs no Manage Roles permission for this access check. Owner/Administrator protections for moderation targets remain unchanged.

| Capability | Purpose |
|---|---|
| dashboard.view | Health, counts and setup overview |
| images.view / add / edit / delete | Independently govern reference-library operations |
| rules.view / create / edit / delete | Independently govern policy management |
| actions.change | Change sanction/deletion/automatic-action settings |
| timeouts.configure | Configure timeout actions/durations |
| kick.enable / ban.enable | Additional action-specific permission gates |
| matching.test | Submit labeled test images; cannot execute sanctions |
| logs.view / logs.export | Inspect retained events; export requires both |
| enforcement.pause | Stop automatic dispatch; cannot resume it |
| moderators.delegate | Restricted subdelegation; not unrestricted permission management |
| channels.configure | Update monitored/excluded channels without changing security settings |
| credentials.manage / security.manage / permissions.manage | Server-manager-only; cannot appear in delegated grants |

An image-only moderator cannot edit sanctions. Reference changes can alter the matching set, so dependent approvals become stale; a server manager must approve the new configuration before it can punish automatically. Enabling enforcement and approving rules remain server-manager operations.

A delegated permission manager cannot assign server-manager-only capabilities, grant capabilities they do not hold, grant the delegation capability itself, modify a role they currently possess, modify @everyone, or edit a grant that exceeds their authority. Server managers can grant @everyone, but the UI requires explicit confirmation.

Suggested roles: observers receive dashboard.view, images.view, rules.view and logs.view; library editors additionally receive appropriate image capabilities; policy editors receive rule capabilities plus explicitly allowed action capabilities. Add matching.test only when API usage is acceptable. Every test consumes the same daily provider budget as operational comparisons.

Role edits/revocations take effect on the next API authority check. Sessions are not authorization snapshots. In-flight provider/Discord operations may complete; pause enforcement before major policy changes.


## Content-analysis permissions

Content rules reuse rules.create, rules.edit, actions.change, matching.test, server-manager approval and high-impact restrictions. Preset listing requires rules.view. Context opt-in uses existing Settings authorization. Preset/threshold edits do not grant enforcement. See [approvals](CONTENT_ANALYSIS.md#approvals-and-persistence).


## Native text moderation (October 17, 2026)

Native text creation/editing and starter installation require a server manager. Preview uses rules.view. Tests reuse matching.test, current membership and same-channel read checks for links. Approval and server text switch remain server-manager operations. Global enforcement, deployment acceptance, exemptions, bot/webhook opt-ins and high-impact safeguards apply. Text tests never moderate. See [API](API.md).

## Agent setup boundaries

Agent setup and standalone sign-in require live Discord owner/Administrator/Manage Server authority. Delegated rule editing alone is insufficient. Ordinary manual pages retain their capability checks. Server checks apply on every request; tools also recheck authority and invalidate on observed permission/session/guild changes. Presets grant no permissions, install no sanctions and approve no rules. Review needs readable monitored channels and a log destination with bot View Channel/Send Messages; message-link testing additionally needs Read Message History. Server managers must verify actual bot/channel permissions in Discord. Pause cannot resume. See [browser onboarding](AGENT_ONBOARDING.md).

## Pack administration

Only current Discord owners or members with Administrator or Manage Server can export, preview or apply packs, including bundled starters and standalone prompt edits. Delegated rule/image capabilities do not confer pack administration. Complete policy grants are opt-in and require destination role mapping; server-manager-only capabilities are rejected. Existing conflicting grants require reconciliation through Permissions rather than silent import overwrite. Channel mappings require current member/bot read access, and log-channel mapping checks send permission. Importing a rule removes source approval and disables it; ordinary destination review, approval, action-specific permissions/hierarchy and enforcement gates remain mandatory. [Pack workflow](MODERATION_PACKS.md).
