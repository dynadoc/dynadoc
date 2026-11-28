<script lang="ts">
  // A change to an organization variable that the API bridge refused because
  // someone changed the variable first. Both values are shown, with who wrote
  // theirs and when; the user keeps one. Nothing is overwritten until then.
  import { _ } from 'svelte-i18n'
  import { organizationConflicts, organizationScope } from '../stores/scopes/organizationScope'
  import { orgChangeLine, previewValue } from '../utils/organizationDisplay.utils'

  let conflict = $derived($organizationConflicts[0] ?? null)
  let busy = $state(false)

  let name = $derived(
    String(conflict?.mine?.name || conflict?.theirs?.value?.name || conflict?.id || '')
  )
  let theirsLine = $derived(conflict?.theirs ? orgChangeLine(conflict.theirs) : null)

  async function keep(side: 'mine' | 'theirs'): Promise<void> {
    if (!conflict || busy) return
    busy = true
    try {
      await organizationScope.resolveConflict(conflict.id, side)
    } finally {
      busy = false
    }
  }
</script>

{#if conflict}
  <div
    class="org-conflict fixed inset-0 z-[1400] flex items-center justify-center bg-black/60 px-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="org-conflict-title"
  >
    <div class="org-conflict__card w-full max-w-[460px] rounded-xl p-6 shadow-2xl">
      <h3 id="org-conflict-title" class="text-lg font-600 mb-2">
        {$_('Someone changed @{name}', { values: { name } })}
      </h3>
      <p class="text-[12px] opacity-70 mb-4">
        {$_(
          'Your change was not saved: the organization value changed while you edited it. Keep one of the two values.'
        )}
      </p>

      <dl class="org-conflict__values">
        <dt>{$_('Theirs')}</dt>
        <dd>
          <bdi>{previewValue(conflict.theirs?.value) ?? $_('Deleted')}</bdi>
          {#if theirsLine}
            <small>{$_(theirsLine.key, { values: theirsLine.values })}</small>
          {/if}
        </dd>
        <dt>{$_('Yours')}</dt>
        <dd>
          <bdi>{previewValue(conflict.mine) ?? $_('Deleted')}</bdi>
        </dd>
      </dl>

      <div class="flex justify-end gap-2 mt-5">
        <button
          type="button"
          class="org-conflict__btn"
          disabled={busy}
          onclick={() => keep('theirs')}
        >
          {$_('Keep theirs')}
        </button>
        <button
          type="button"
          class="org-conflict__btn org-conflict__btn--primary"
          disabled={busy}
          onclick={() => keep('mine')}
        >
          {$_('Keep mine')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .org-conflict__card {
    background: var(--color-base-100);
    color: var(--color-base-content);
    border: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent);
  }
  .org-conflict__values {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    font-size: 13px;
  }
  .org-conflict__values dt {
    font-weight: 600;
  }
  .org-conflict__values dd {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .org-conflict__values small {
    font-size: 11px;
    opacity: 0.7;
  }
  .org-conflict__btn {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 20%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .org-conflict__btn--primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-content);
  }
  .org-conflict__btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }
</style>
