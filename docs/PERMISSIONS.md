# Roles and capabilities

The guild owner and members with Discord Administrator receive all capabilities automatically. All other members begin with none, regardless of role name. Multiple role grants combine additively; per-role deny overrides are not implemented. Backend requests always refresh Discord authority.

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
| credentials.manage / security.manage / permissions.manage | Administrator-only; cannot appear in delegated grants |

An image-only moderator cannot edit sanctions. Reference changes can alter the matching set, so dependent approvals become stale; an administrator must approve the new configuration before it can punish automatically. Enabling enforcement and approving rules remain administrator operations.

A delegated permission manager cannot assign administrator-only capabilities, grant capabilities they do not hold, grant the delegation capability itself, modify a role they currently possess, modify @everyone, or edit a grant that exceeds their authority. Administrators can grant @everyone, but the UI requires explicit confirmation.

Suggested roles: observers receive dashboard.view, images.view, rules.view and logs.view; library editors additionally receive appropriate image capabilities; policy editors receive rule capabilities plus explicitly allowed action capabilities. Add matching.test only when API usage is acceptable. Every test consumes the same daily provider budget as operational comparisons.

Role edits/revocations take effect on the next API authority check. Sessions are not authorization snapshots. In-flight provider/Discord operations may complete; pause enforcement before major policy changes.


## Content-analysis permissions

Content rules reuse rules.create, rules.edit, actions.change, matching.test, administrator approval and high-impact restrictions. Preset listing requires rules.view. Context opt-in uses existing Settings authorization. Preset/threshold edits do not grant enforcement. See [approvals](CONTENT_ANALYSIS.md#approvals-and-persistence).


## Native text moderation (October 17, 2026)

Native text creation/editing and starter installation require administrator. Preview uses rules.view. Tests reuse matching.test, current membership and same-channel read checks for links. Approval and server text switch remain administrator operations. Global enforcement, deployment acceptance, exemptions, bot/webhook opt-ins and high-impact safeguards apply. Text tests never moderate. See [API](API.md).
