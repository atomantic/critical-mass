// Stand-in for admin/src/components/ui/ConfirmDialog in tests that render admin
// components by walking the React element tree (they never call components).
// It carries the same visible content as the real dialog: title, description,
// body, error, then Cancel and Confirm. `expand` swaps a fixture element for its
// rendering, so call it on each node before reading `type` / `props.children`.
const path = require('node:path')
const { createRequire } = require('node:module')
const React = createRequire(path.join(__dirname, '..', 'admin/package.json'))('react')

function ConfirmDialogFixture({ title, description, children, error, cancelLabel = 'Cancel', confirmLabel, busyLabel, busy, onClose, onConfirm, extraActions }) {
  return React.createElement('div', null, title, description, children, error,
    React.createElement('button', { onClick: onClose, disabled: busy }, cancelLabel),
    React.createElement('button', { onClick: onConfirm, disabled: busy }, busy ? busyLabel ?? confirmLabel : confirmLabel),
    extraActions)
}
const expand = tree => (React.isValidElement(tree) && tree.type === ConfirmDialogFixture ? ConfirmDialogFixture(tree.props) : tree)

module.exports = { ConfirmDialogFixture, expand }
