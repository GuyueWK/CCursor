/** Server 状态行 */
export function Server() {
  return (
    <>
      <div x-show="$store.app.state" class="server-row">
        <span>
          <span x-text="$store.app.state?.server === 'offline' ? '🔴' : '🟢'"></span>
          {' '}
          <span x-text="$store.app.serverLabel"></span>
        </span>
        <button
          x-show="$store.app.state?.server === 'local' || $store.app.state?.server === 'offline'"
          x-text="$store.app.state?.server === 'local' ? 'Stop Server' : 'Start Server'"
          x-bind:disabled="$store.app.state?.serverIssue === 'port_occupied'"
          x-bind:title="$store.app.state?.serverIssue === 'port_occupied' ? 'Port is occupied by another process' : ''"
          x-on:click="$store.app.post('toggleServer')"
        >
        </button>
      </div>
      <div class="field auto-review-field" x-show="$store.app.state">
        <label>Auto-review model</label>
        <div
          class="custom-select"
          x-data="{ open: false, hover: -1 }"
          {...{ 'x-on:click.outside': 'open = false' }}
        >
          <button
            type="button"
            class="custom-select-trigger"
            x-on:click="open = !open"
            {...{ 'x-on:keydown.escape.prevent': 'open = false' }}
            title="Classifier for Cursor Auto-review run mode"
          >
            <span class="custom-select-label" x-text="$store.app.autoReviewModelLabel()"></span>
            <span class="custom-select-caret" x-text="open ? '▲' : '▼'"></span>
          </button>
          <div class="custom-select-dropdown" x-show="open" x-cloak>
            <div
              class="custom-select-option"
              x-bind:class="{ 'selected': !$store.app.state?.autoReviewModelId, 'hover': hover === -1 }"
              x-on:mouseenter="hover = -1"
              x-on:click="$store.app.setAutoReviewModelId(''); open = false"
            >
              Use current Agent model
            </div>
            <template x-for="(m, idx) in $store.app.autoReviewModelOptions()" x-bind:key="m.id">
              <div
                class="custom-select-option"
                x-bind:class="{ 'selected': $store.app.state?.autoReviewModelId === m.id, 'hover': hover === idx }"
                x-on:mouseenter="hover = idx"
                x-on:click="$store.app.setAutoReviewModelId(m.id); open = false"
                x-text="m.label"
              >
              </div>
            </template>
          </div>
        </div>
        <div class="auto-review-hint">Used when Cursor Run Mode is Auto-review. Prefer a fast, cheap model.</div>
      </div>
    </>
  )
}
