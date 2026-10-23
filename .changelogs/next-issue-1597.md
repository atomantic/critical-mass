# Issue #1597: Share admin button styling and touch targets

Ordinary admin actions now use the shared Button component for consistent variants, sizing, disabled behavior, and mobile touch targets. Existing controls that needed a 44px target on desktop retain it through the component's `touchTarget="always"` option. Menu, disclosure, tooltip, switch, toast-dismiss, and color-coded picker controls keep their specialized native markup.
