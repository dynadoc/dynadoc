// Moving an organization variable to another scope deletes it from the
// organization, for every member. That is never done without asking, and
// never by someone who may not change it.
import { get } from 'svelte/store'
import { _ } from 'svelte-i18n'
import { openConfirmModal } from '../../../../stores/confirmModal.store'
import { openAlertModal } from '../../../../stores/alertModal.store'
import { organizationScope } from '../stores/scopes/organizationScope'
import { isOrganizationVisibility } from './sheetVariables.utils'

/**
 * True when the change may go ahead: the variable stays in the organization,
 * or the user confirmed taking it out of it.
 */
export async function confirmLeavingOrganization(
  id: string | null | undefined,
  current: { visibility?: unknown; name?: unknown } | null | undefined,
  nextVisibility: unknown
): Promise<boolean> {
  if (!isOrganizationVisibility(current?.visibility) || isOrganizationVisibility(nextVisibility)) {
    return true
  }
  const t = get(_)
  const name = String(current?.name || '')
  if (id && organizationScope.meta(id)?.canWrite === false) {
    openAlertModal({
      title: t('Organization variable'),
      message: t('You can read @{name} but not change it: it stays in the organization.', {
        values: { name }
      })
    })
    return false
  }
  return Boolean(
    await openConfirmModal({
      title: t('Remove @{name} from the organization?', { values: { name } }),
      message: t(
        'Everyone in the organization loses this variable. It is kept here, in the scope you chose.'
      ),
      confirmText: t('Remove from the organization'),
      destructive: true
    })
  )
}
