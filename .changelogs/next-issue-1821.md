## Bug Fixes

- Keep newer UpDown contract edits when save confirmation and status readbacks arrive in ContractSetup, preserving in-progress and unsent draft changes.
- Add write serialization between Save and screenshot Apply so contract writes cannot overlap, and retain failed-save draft state for retry.
