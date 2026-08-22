/**
 * What a write leaves the build-time flag as: what the caller asked for, else what
 * the row already held, else the default for a key that does not exist yet.
 *
 * That default is BUILD-TIME. A value the build turns out to need is the common case
 * (anything a client bundle inlines, anything a migration or codegen step reads), and
 * a build that cannot see one fails in a way that is hard to read back to a missing
 * flag. Being wrong the other way writes the value into the image, which is why every
 * authoring surface says so next to the control. Same choice the editor has always
 * made for a new variable.
 *
 * Shared because two places need the same answer - the store, to write the row, and
 * the caller deciding whether the change needs a rebuild or only a restart.
 */
export function resolveSecretBuildTime(requested: boolean | undefined, stored: boolean | undefined): boolean {
    return requested ?? stored ?? true;
}
