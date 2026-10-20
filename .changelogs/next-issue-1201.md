# Issue #1201: Validate exchange credentials before saving

The exchange key routes now trim and cap credential fields, apply the same shape rules as the adapters, and reject invalid replacements before writing. Save responses report the adapter's actual configured state.
