# Build a Complete Discord Text and Image Moderation Bot Powered by TypeSafe Jev

## 1. Project Objective

Design, implement, test, and document a fully functional Discord moderation bot with an embedded Discord Activity management interface.

**The bot moderates configured observable text and image policies through one deterministic enforcement engine.**

Use **Jev, TypeSafe AI's image-capable decision model**, to compare posted images against a configurable library of reference images and determine whether a moderation rule has been triggered.

When a matching image is detected, automatically execute the moderation action assigned by the server administrator.

The application must also provide an embedded Discord Activity where authorized server administrators and designated moderators can manage images, configure matching rules, assign moderation actions, change settings, and securely manage Jev API credentials.

The bot must operate continuously without requiring the Discord Activity to remain open.

### Strict Project Scope

The application supports opt-in native text moderation alongside image content analysis and reference-image matching. See [native text specification](TEXT_MODERATION.md).

Do not implement:
- Conversation-wide or historical text analysis.
- Unconfigured generic profanity judgments.
- Inferring repetition from a single text message.
- Conversation analysis.
- Chatbot responses or conversational AI.
- Voice moderation.
- Unrelated AI assistants.
- Unnecessary social or entertainment features.

All functionality must directly support text analysis, image detection, matching, moderation, administration, permissions, or operational monitoring.

---

## 2. Core Image Moderation Workflow

The bot must automatically monitor supported image attachments in configured Discord text channels.

### Required workflow

1. A Discord user posts a message containing one or more images.
2. Discord sends the appropriate message event to the bot.
3. The bot identifies the image attachments.
4. The bot securely downloads and validates the image data.
5. The image is normalized into a format supported by Jev.
6. The bot retrieves the relevant image-matching rules for the Discord server.
7. Jev compares the posted image against the reference images associated with those rules.
8. The application evaluates Jev's structured answers against configured matching thresholds.
9. If a qualifying match is found, the bot resolves the applicable moderation rule.
10. The bot automatically performs the configured Discord moderation action.
11. The moderation event is recorded in an audit log.
12. The bot continues monitoring subsequent messages.

**No manual intervention should be required for matches that satisfy the configured automatic-enforcement criteria.**

Messages without supported images must be ignored.

The bot must support messages containing multiple images and evaluate each image independently.

Process image-bearing message edits where Discord provides sufficient information to identify newly added images, preventing duplicate enforcement.

### Example

An administrator uploads a reference image named `Blocked Image A` and assigns the action `Ban User`.

A Discord member subsequently posts the same image, including an allowed variation of it.

Jev identifies the match with sufficient confidence.

The bot automatically bans the member, subject to Discord permissions and the configured enforcement safeguards.

The audit log captures which image matched, which rule was applied, the model result, and the outcome.

---

## 3. Jev Integration — Mandatory

**Jev must be the AI component responsible for evaluating visual similarity and determining whether a posted image matches a configured reference.**

Use TypeSafe AI's official documentation and supported APIs.

Official resources:

- https://docs.typesafe.ai/
- https://docs.typesafe.ai/images
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/primitives/box

### API requirements

Use the official TypeSafe endpoint:

`POST https://api.typesafe.ai/v1/systemone`

Use the image-capable Jev model, initially pinning `jev-1.14.0` where appropriate.

Enable the experimental image functionality with:

`TypeSafe-Danger-Zone-Images: true`

Support authenticated requests with the server-configured API key.

Use TypeSafe's official JavaScript SDK when practical.

Jev's image support is currently experimental. Design the integration to accommodate API changes and enforce additional safeguards around destructive actions.

### Image matching requirements

Implement configurable matching behavior:

**Exact visual match**

Determine whether the submitted image is visually the same as a reference image.

**Transformed image match**

Support matching substantially identical images even when they have undergone common transformations, such as:
- Resizing.
- Recompression.
- Format conversion.
- Small crops.
- Added borders.
- Minor color changes.
- Small overlays or watermarks.

**Partial image match**

Optionally identify a reference image appearing within a larger submitted image.

**Semantic matching**

Offer an explicitly separate, disabled-by-default matching mode that detects conceptually similar images rather than copies of the reference.

Do not treat two different photographs of the same subject as an exact image match.

### Matching implementation

Use Jev's structured decision primitives.

A suitable approach is:

- `Noul` questions to independently determine whether the submitted image matches a specific reference.
- `Choice` questions when selecting among a small group of candidate references.
- An explicit no-match outcome.
- Configurable thresholds for automatic enforcement.
- Separate handling for ambiguous results.
- Optional `Box` questions when locating a reference image within a larger composition is necessary.

The implementation must use the actual TypeSafe request and response schemas rather than parsing free-form generated text.

Maintain the reference-image library within the application's own storage. Do not assume Jev provides a persistent hosted image library unless that capability is verified in official documentation.

Implement an image-comparison service that constructs Jev requests using the uploaded image and applicable reference images.

Observe TypeSafe's limits on file formats, dimensions, request size, and model context.

Batch comparisons appropriately to prevent excessive token consumption or request failures.

### Confidence handling

Allow administrators to configure:

- Minimum confidence for an automatic match.
- Higher thresholds for severe moderation actions.
- Whether uncertain matches are ignored or placed into a review queue.
- Whether high-impact decisions require a second verification.
- Whether each rule is enabled for automatic enforcement.

Do not hardcode arbitrary model probabilities as validated accuracy guarantees.

Provide a mechanism to test and calibrate thresholds against labeled matching and nonmatching image examples.

False positives must never silently trigger automatic bans.

---

## 4. Configurable Moderation Rules

Administrators must be able to create rules that map images or image conditions to moderation actions.

### Rule Mode A — Individual image rules

Each reference image can have a different action.

Examples:

| Reference image | Action |
|---|---|
| Image A | Delete message |
| Image B | Timeout for 10 minutes |
| Image C | Kick user |
| Image D | Ban user |
| Image E | Flag for moderator review |

Administrators must be able to add, modify, disable, and delete these rules independently.

### Rule Mode B — Any matching reference image

Allow administrators to specify one action that applies whenever a posted image matches **any active reference image** in the server's blocked-image library.

Example:

`Any image matching the blocked-image library → 1-hour timeout`

This eliminates the need to assign actions to individual references.

### Rule Mode C — Any uploaded image

Optionally support an explicit global rule targeting any image posted in selected channels, regardless of whether it matches the reference library.

Example:

`Any image posted in #announcements → Delete message`

This mode must be visibly distinct from reference-image matching, because it does not require a positive Jev similarity result.

It must be disabled by default.

### Rule Mode D — Image groups

Allow administrators to organize reference images into named groups.

Examples:
- Banned memes.
- Prohibited promotional graphics.
- Harassment-related images.
- Server-specific prohibited material.

Each group can have a default moderation action.

Individual image rules may optionally override the group action.

### Rule precedence

Provide deterministic rule resolution.

Support a sensible default order:

1. Explicit individual-image rule.
2. Image-group rule.
3. Global action for any matching reference image.
4. Explicit unrestricted any-image rule, according to administrator-defined priority.

Allow administrators to inspect and configure precedence where necessary.

If several rules match one message, avoid performing duplicate or contradictory moderation actions.

Record all matches, but select one effective user-level action according to the configured priority policy.

---

## 5. Supported Moderation Actions

The administrator must be able to select the action assigned to each rule.

Required actions:

| Action | Required behavior |
|---|---|
| No action | Detect and log only |
| Delete message | Delete the message containing the matching image |
| Warn | Issue a configurable moderation warning |
| Timeout | Apply a configurable Discord timeout |
| Kick | Remove the member from the server |
| Ban | Ban the member from the server |
| Review | Create a moderation review event without automatic punishment |

Allow supported combinations, including deleting the offending message and applying a user-level sanction.

### Timeout configuration

Support predefined durations and a custom duration selector within Discord's supported limits.

Examples:
- 1 minute.
- 5 minutes.
- 10 minutes.
- 1 hour.
- 1 day.
- 7 days.
- 28 days.

### Additional behavior

Support:
- Configurable moderation reason.
- Optional direct-message notification to the affected user.
- Optional moderator log-channel notification.
- Server-specific action settings.
- Role exemptions.
- Channel exemptions.
- A test-only mode that records intended actions without executing them.
- Protection against repeated sanctions from duplicate events.
- Optional escalation policies for repeated image violations.

Do not add unrelated moderation capabilities.

The bot must respect Discord's role hierarchy, permission system, action limits, and API rate limits.

Actions must not execute when Discord permissions prohibit them.

---

## 6. Embedded Discord Activity

Develop a complete graphical management interface using the official Discord Embedded App SDK.

Reference:

https://docs.discord.com/developers/activities/overview

The Activity serves as the control panel for the moderation bot.

It should operate inside Discord and authenticate the current user through Discord's supported authorization mechanisms.

**The Activity is not responsible for continuous monitoring.** The backend bot monitors messages independently.

### Main Activity sections

#### A. Dashboard

Display:

- Bot online/offline status.
- Jev API connection status.
- Number of active reference images.
- Number of active rules.
- Number of recent image evaluations.
- Number of detected matches.
- Number of successful moderation actions.
- Number of failed or suppressed actions.
- Recent moderation activity.

Provide a clear indication of whether automatic enforcement is enabled.

#### B. Image Library

Build a graphical interface for managing reference images.

Administrators and authorized moderators must be able to:

- Upload one or multiple images.
- Preview images.
- Give images descriptive names.
- Edit image metadata.
- Organize images into groups.
- Assign moderation actions.
- Configure matching thresholds.
- Enable or disable individual images.
- Search and filter the library.
- Replace an existing reference image.
- Remove reference images.
- View which rules reference an image.
- View matching history.

Each image should display its current rule and action.

Provide bulk management operations for authorized users.

#### C. Rule Editor

Build an intuitive visual rule editor.

Example:

**When:** Image matches `Blocked Image A`

**Matching mode:** Exact or transformed match

**Confidence:** Administrator-defined threshold

**Then:** Timeout user

**Duration:** 1 hour

**Also:** Delete offending message

**Enabled:** Yes

The user should be able to configure this without programming knowledge.

Support both individual-image rules and global rules.

Provide a rule-testing interface where authorized staff can upload a sample image and see whether it would trigger a match.

The test must not perform a real moderation action.

#### D. Activity Logs

Display a searchable, filterable event history.

Include:
- Timestamp.
- Discord server.
- Discord channel.
- User identifier.
- Message identifier.
- Submitted image thumbnail, subject to retention settings.
- Matched reference image.
- Matching score or probability.
- Jev model version.
- Rule applied.
- Intended action.
- Actual action.
- Success or failure.
- Failure reason.

Support appropriate export and retention controls.

#### E. Settings

Provide administrative controls for:

- Monitoring enabled/disabled.
- Automatic enforcement enabled/disabled.
- Monitored channels.
- Excluded channels.
- Default rule behavior.
- Match thresholds.
- Role exemptions.
- Log channel.
- Notification behavior.
- Jev API settings.
- API usage limits.
- Image retention.
- General bot health.

---

## 7. Advanced Role-Based Permissions

Implement a granular Discord-aware permission system.

The server owner and users possessing Discord's `ADMINISTRATOR` permission must receive full administrative access automatically.

Moderators must **not** receive unrestricted access by default.

A server administrator must explicitly authorize moderator roles and specify what they can do.

### Permission model

Support authorization based on Discord roles and configurable capability grants.

Administrators should be able to assign permissions to one or more roles.

Required configurable capabilities:

| Capability | Administrator | Delegated moderator |
|---|---|---|
| View dashboard | Yes | Configurable |
| View image library | Yes | Configurable |
| Add reference images | Yes | Configurable |
| Edit reference images | Yes | Configurable |
| Remove reference images | Yes | Configurable |
| Create rules | Yes | Configurable |
| Edit rules | Yes | Configurable |
| Delete rules | Yes | Configurable |
| Change moderation actions | Yes | Configurable |
| Configure timeouts | Yes | Configurable |
| Enable kick actions | Yes | Configurable |
| Enable ban actions | Yes | Configurable |
| Test image matching | Yes | Configurable |
| View moderation logs | Yes | Configurable |
| Export logs | Yes | Configurable |
| Pause enforcement | Yes | Configurable |
| Manage other moderators' access | Yes | Configurable |
| Configure monitored channels | Yes | Configurable |
| Change API credentials | Yes | No |
| Manage security settings | Yes | No |
| Manage server-wide permissions | Yes | No |

### Administrative requirements

- Automatically recognize Discord server ownership and the Administrator permission.
- Allow administrators to designate moderator roles.
- Permit multiple moderator roles with distinct capabilities.
- Allow role permissions to be modified or revoked.
- Support read-only moderators.
- Support image-management moderators who cannot change sanctions.
- Support policy moderators who can manage rules but not API credentials.
- Provide optional approval requirements for destructive rule changes.
- Provide an effective-permissions view showing what each role can do.
- Apply permissions separately for each Discord server.
- Revalidate role membership and effective permissions server-side.

**Security requirement:** Never rely solely on hiding buttons or screens in the Discord Activity. Every backend request must verify the authenticated user's current authority.

Users without permission must not be able to bypass restrictions by calling backend APIs directly.

---

## 8. Secure Jev API Key Management

The server administrator must be able to securely add, validate, replace, and rotate the Jev API key directly inside the Discord Activity.

This is a mandatory feature.

### Required functionality

Provide an administrative screen with:

- Secure API key input.
- Save credential.
- Test API connection.
- Replace API key.
- Remove or disable credential.
- View masked credential status.
- View last successful connection check.
- View recent API authentication errors.
- View configured Jev model.

### Security requirements

1. API keys must never be embedded in frontend JavaScript bundles.
2. API keys must never be exposed to the Discord client after submission.
3. Store credentials encrypted at rest using a properly managed encryption key or secrets-management service.
4. Use TLS for all credential submission and backend communication.
5. Restrict access to credential management to server owners and administrators.
6. Never expose an existing API key through a GET endpoint.
7. Never include credentials in logs, analytics, error responses, or exports.
8. Allow key replacement without restarting the bot.
9. Validate replacement credentials before activating them.
10. Preserve the previous working credential when validation of a replacement fails.
11. Support safe credential rotation and revocation.
12. Include audit events for credential changes without recording the credential itself.

### Multi-server support

Support independently configured Jev credentials per Discord guild.

Ensure that one server's credentials, reference images, permissions, and moderation history cannot be accessed by another server.

If a centrally supplied API key is supported, make that a separate application-owner setting, not something exposed to Discord server administrators.

### Credential failure behavior

If the API key is missing, invalid, expired, or otherwise unusable:

- Mark Jev connectivity as unhealthy.
- Suspend automatic decisions that depend on Jev.
- Record the operational failure.
- Notify authorized administrators through configured channels where possible.
- Never fabricate a matching result.
- Never impose a sanction because an API call failed.

---

## 9. Architecture

Use a maintainable TypeScript-based architecture unless a clearly better choice is justified.

Suggested components:

**Discord bot**
- Node.js and TypeScript.
- A maintained Discord SDK or discord.js.
- Discord Gateway event handling.
- Discord REST API moderation operations.

**Discord Activity**
- React and TypeScript.
- Vite.
- Official Discord Embedded App SDK.
- Responsive UI suitable for the embedded Discord client.

**Backend**
- Node.js and TypeScript.
- A framework such as Fastify or NestJS.
- Authenticated REST endpoints.
- Server-side authorization.
- Jev integration service.
- Moderation policy engine.

**Persistence**
- PostgreSQL for application records.
- Database migrations.
- Object storage for reference images.
- Optional Redis-backed work queues for asynchronous processing and rate limiting.

### Required logical components

Implement separate services for:

1. Discord event ingestion.
2. Image extraction and validation.
3. Image normalization.
4. Reference-image management.
5. Jev evaluation.
6. Match threshold and policy evaluation.
7. Moderation action execution.
8. Discord authorization and RBAC.
9. Secure API-key management.
10. Audit logging.
11. Activity API and interface.
12. Operational health and metrics.

Keep the architecture proportionate to the narrow purpose of the product.

Avoid unnecessary microservices.

### Image processing

Securely fetch Discord-hosted attachments.

Validate actual image content, file size, and format.

Normalize images to TypeSafe's supported PNG/JPEG format and documented dimension limits.

Handle images with unusual orientation and reject malformed inputs safely.

Prevent malicious remote downloads, server-side request forgery, decompression bombs, excessive memory usage, and unsupported file types.

Only inspect user-submitted image data required for moderation.

---

## 10. Discord Integration Requirements

Use the currently supported Discord API and Embedded App SDK.

### Bot permissions

Request only permissions required for enabled features, including where appropriate:

- View Channels.
- Read Message History.
- Manage Messages.
- Moderate Members.
- Kick Members.
- Ban Members.

Handle the Message Content privileged intent as required to access message attachments and embeds.

Document how to enable the relevant intents in the Discord Developer Portal and identify any approval requirements for verified applications.

### Discord Activity integration

Implement:

- Application registration.
- Activity configuration.
- Discord OAuth2 authentication.
- Embedded App SDK initialization.
- Server identification.
- Server-side verification of guild membership and permissions.
- Management API session authentication.
- Guild-scoped access control.
- Proper Activity launch configuration.

Do not treat the Discord SDK's client-provided guild identifier or role information as sufficient proof of authorization.

### Operational behavior

The bot must:

- Operate continuously on the backend.
- Survive temporary Discord disconnections.
- Reconnect safely.
- Respect API limits.
- Avoid processing duplicate message events more than once.
- Support multiple servers.
- Respect Discord's role hierarchy.
- Avoid moderating protected users when Discord prohibits it.
- Default to ignoring other bots and webhook messages unless an administrator explicitly enables applicable processing.
- Never impose actions in response to messages from another server's reference library.

---

## 11. Matching Reliability and Enforcement Safety

Because Jev image support is experimental, reliability must be evaluated explicitly.

### Required safeguards

- Start new installations in monitoring-only mode until configured and validated.
- Provide a one-click administrator-controlled switch for enabling automatic enforcement.
- Support independent enforcement thresholds for delete, timeout, kick, and ban.
- Require higher validation standards for kick and ban than for nonpunitive logging.
- Support additional verification for permanent bans.
- Fail safely if Jev returns an error or unexpected response.
- Never convert an uncertain match into a guaranteed match.
- Record model version and structured matching results.
- Provide a way to identify and correct false positives.
- Implement idempotent moderation execution.
- Prevent repeated actions caused by multiple matching images in the same message.

Allow administrators to disable automatic enforcement immediately without disabling the entire bot.

Do not claim the system is accurate enough for production enforcement without testing against representative image examples.

---

## 12. Image Library and Data Model

Create appropriate persistent entities.

At minimum:

**GuildSettings**
- Guild ID.
- Monitoring status.
- Enforcement status.
- Selected channels.
- Excluded channels.
- Matching defaults.
- Logging configuration.

**ReferenceImage**
- Unique identifier.
- Guild ID.
- Name.
- Storage reference.
- File metadata.
- Group membership.
- Enabled status.
- Created by.
- Created timestamp.

**ModerationRule**
- Unique identifier.
- Guild ID.
- Rule name.
- Rule type.
- Reference image or image group.
- Matching mode.
- Threshold.
- Moderation action.
- Action parameters.
- Priority.
- Enabled status.

**RolePermissions**
- Guild ID.
- Discord role ID.
- Granted capabilities.
- Last modification details.

**GuildApiCredentials**
- Guild ID.
- Encrypted credential reference.
- Model configuration.
- Validation status.
- Last rotation timestamp.

**ImageEvaluation**
- Guild ID.
- Message ID.
- Submitted image metadata.
- Jev model version.
- Matched reference.
- Matching confidence.
- Evaluation outcome.
- Timestamp.

**ModerationEvent**
- Guild ID.
- Channel ID.
- Message ID.
- User ID.
- Matched rule.
- Intended action.
- Actual result.
- Error details.
- Timestamp.

**AuditEvent**
- Actor.
- Guild.
- Action performed.
- Target record.
- Timestamp.
- Nonsecret change metadata.

Use database constraints, indexes, and appropriate relationships.

Use durable identifiers and avoid unnecessarily storing submitted images indefinitely.

---

## 13. User Experience

The Discord Activity should feel like a native administrative interface.

Design requirements:

- Dark-mode-friendly Discord visual styling.
- Clean, responsive layouts.
- Image thumbnails and previews.
- Drag-and-drop upload where supported.
- Clear moderation-action selectors.
- Simple rule creation.
- Role-permission management with toggles.
- Useful validation messages.
- Loading and error states.
- Confirmation for destructive changes.
- Accessible controls.
- Mobile-friendly layout where supported by Discord Activities.

### Primary workflow

An administrator should be able to:

1. Open the Discord Activity.
2. Enter and validate the Jev API key.
3. Upload a prohibited reference image.
4. Select a matching mode.
5. Choose `Timeout`, `Kick`, `Ban`, or another supported action.
6. Save the rule.
7. Test the rule against a sample image.
8. Enable automatic enforcement.
9. Close the Activity.

The bot must continue working automatically.

### Moderator workflow

An authorized moderator should be able to:

1. Open the Activity.
2. Access only screens permitted by their roles.
3. Upload or manage images if authorized.
4. Assign or modify actions only if authorized.
5. Save approved changes.
6. View relevant moderation events.

The backend must enforce all restrictions.

---

## 14. Testing Requirements

Implement automated unit, integration, security, and end-to-end tests.

### Core tests

- Ignore messages with no images.
- Process messages with one image.
- Process messages with multiple images.
- Detect a reference-image match.
- Reject a nonmatching image.
- Recognize supported transformed-image variants.
- Avoid confusing visually similar but distinct images.
- Apply the correct individual-image action.
- Apply group-level actions.
- Apply global matching actions.
- Apply any-image rules only when explicitly enabled.
- Resolve overlapping rules correctly.
- Prevent duplicate enforcement.
- Apply configured timeout durations.
- Handle Discord permission failures.
- Handle role hierarchy restrictions.
- Handle unavailable Jev services.
- Handle API authentication failures.
- Handle image validation failures.
- Handle Discord rate limits.

### Permission tests

Verify:

- Server owners can administer the application.
- Discord administrators receive full access.
- Moderators receive only explicitly delegated capabilities.
- Unauthorized users cannot modify images.
- Unauthorized users cannot modify actions.
- Moderators cannot access API keys.
- Cross-server access is denied.
- Revoked permissions stop working.
- Forged frontend permission claims have no effect.

### Credential tests

Verify:

- API key submission succeeds.
- Keys are encrypted at rest.
- Existing keys cannot be retrieved as plaintext.
- Invalid replacement keys do not overwrite valid credentials.
- API key rotation works without restarting the bot.
- Credential values are absent from logs.
- Unauthorized credential changes fail.

### Matching evaluation

Create a labeled image test suite containing:
- Exact duplicates.
- Resized duplicates.
- Recompressed duplicates.
- Cropped variants.
- Watermarked variants.
- Images with similar content that should not match.
- Completely unrelated images.

Measure false-positive and false-negative behavior.

Report results separately by matching mode and Jev model version.

---

## 15. Deployment and Documentation

Provide a complete deployable project.

Include:

- Source code for the Discord bot.
- Source code for the Discord Activity.
- Backend API.
- Jev integration.
- Database schemas and migrations.
- Secure credential storage.
- Configuration examples.
- Automated tests.
- Dockerfiles.
- Docker Compose development environment.
- Production deployment guidance.
- CI configuration.
- Setup documentation.
- Security documentation.
- Permission documentation.
- API documentation.
- Troubleshooting instructions.

Document:

1. Creating a Discord application.
2. Creating the Discord bot.
3. Enabling the required Discord intents.
4. Configuring the bot permissions.
5. Enabling Discord Activities.
6. Registering the embedded application.
7. Configuring OAuth2.
8. Provisioning the database and image storage.
9. Starting the services.
10. Adding the Jev API key.
11. Creating the first image rule.
12. Testing a rule.
13. Enabling automatic enforcement.
14. Rotating credentials.
15. Adding moderator roles.

Include a concise explanation of operational costs, including Jev image-token usage and storage.

---

## 16. Acceptance Criteria

The implementation is complete only when all of the following are satisfied:

- [ ] The bot automatically detects image attachments posted to configured Discord channels.
- [ ] Native text moderation is disabled by default, explicitly configured and independently calibrated; text-only messages are evaluated only when applicable text rules exist.
- [ ] Jev is integrated using the official image-capable API.
- [ ] Administrators can upload reference images.
- [ ] Jev can compare submitted images against registered references.
- [ ] The system supports exact and permitted transformed-image matching.
- [ ] Each reference image can have its own moderation action.
- [ ] A single action can apply to any matched reference image.
- [ ] An optional global rule can apply to any posted image.
- [ ] Administrators can configure timeouts, kicks, bans, and message deletion.
- [ ] Matching rules operate automatically once enforcement is enabled.
- [ ] The bot runs independently of the Activity.
- [ ] The Discord Activity opens and authenticates successfully.
- [ ] Administrators have a functional graphical control panel.
- [ ] Discord server administrators have full access by default.
- [ ] Moderators have only explicitly granted permissions.
- [ ] The administrator can securely configure and rotate the Jev API key.
- [ ] Existing API keys are never exposed to frontend users.
- [ ] All backend permissions are enforced server-side.
- [ ] Separate Discord servers have isolated configuration and data.
- [ ] Matching outcomes and moderation actions are logged.
- [ ] Uncertain matches and API failures do not trigger punitive actions.
- [ ] Automated tests pass.
- [ ] Deployment and operational documentation are complete.

---

## 17. Implementation Instructions

This is an **end-to-end implementation assignment**, not merely an architecture exercise.

Proceed in the following order:

**Phase 1 — Research and validation**

Verify the latest official Discord and TypeSafe Jev documentation, supported image request formats, permissions, SDK behavior, API constraints, and experimental feature limitations.

Identify technical restrictions before choosing the final implementation strategy.

**Phase 2 — Core bot**

Implement Discord message monitoring, image extraction, reference-image storage, Jev integration, rule matching, and automatic moderation.

**Phase 3 — Backend administration**

Implement server-specific settings, secure credential management, RBAC, rule management, and audit records.

**Phase 4 — Discord Activity**

Build the complete embedded graphical administration interface and integrate it with the backend.

**Phase 5 — Reliability and security**

Implement confidence gating, error handling, retries, duplicate prevention, role enforcement, credential encryption, and operational safeguards.

**Phase 6 — Testing and validation**

Execute the automated tests and image-matching evaluation suite. Fix identified problems and document experimental API limitations.

**Phase 7 — Packaging and deployment**

Prepare the application for installation, configuration, and hosting.

### Final deliverables

Provide:

1. A working Discord bot.
2. A working embedded Discord Activity.
3. A complete backend.
4. Database and image-storage implementations.
5. Secure Jev API credential management.
6. Comprehensive tests.
7. Deployment configuration.
8. Complete setup and administration documentation.

Clearly distinguish implemented functionality from features that remain experimental or require external approval.

Do not claim successful deployment, real Discord moderation, or verified Jev matching without actual execution evidence.

### Final architectural principle

**Keep the entire project focused on one operation:**

A user posts an image. Jev determines whether that image matches a configured reference. The configured policy determines the action. The bot executes that action automatically.

The Discord Activity exists exclusively to manage the images, rules, permissions, credentials, and operational settings that support that workflow.

Do not expand beyond this purpose.## Historical image scanning

See [Historical scans](HISTORICAL_SCANS.md) for administrator scope selection,
review-only results, permissions, fixed cutoffs, shared quotas, recovery,
coverage exclusions, migration 003, privacy and validation instructions.

## Browser-assisted onboarding

Administrators can independently authenticate to the browser dashboard or connect to the Activity, inspect structured tools where supported, preview four reusable starter compositions, customize/review an exact revision-bound plan, explicitly accept it and apply it with a receipt. New rules are disabled/review-only; enforcement activation retains existing separate gates. Unsupported browsers use the same manual planner. [The guide](AGENT_ONBOARDING.md) describes scope, browser support and unverified Discord iframe/OAuth/provider gates.
