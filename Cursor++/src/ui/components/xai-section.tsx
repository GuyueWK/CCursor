/** SuperGrok Subscription 登录区 — xAI OAuth device-code 流程 */
export function XaiSection() {
  return (
    <>
      {/* 已登录态 */}
      <div class="server-row" x-show="$store.app.state?.xai?.loggedIn">
        <span>
          <span>🟣</span>
          {' '}
          <span>SuperGrok connected</span>
          {' '}
          <span
            style="opacity:.6;font-size:10px"
            {...{ 'x-effect': '$el.textContent = $store.app.xaiExpiryLabel()' }}
          >
          </span>
        </span>
        <button
          class="ghost"
          x-on:click="$store.app.logoutXai()"
          x-bind:disabled="$store.app.xaiWorking"
        >
          Log out
        </button>
      </div>
      {/* 未登录态 */}
      <div class="server-row" x-show="$store.app.state && !$store.app.state?.xai?.loggedIn">
        <span>
          <span>⚪</span>
          {' '}
          <span>SuperGrok not connected</span>
        </span>
        <button
          x-on:click="$store.app.startXaiLogin()"
          x-bind:disabled="$store.app.xaiWorking"
          x-text="$store.app.xaiWorking ? 'Waiting…' : 'Log in with SuperGrok'"
        >
        </button>
      </div>
      {/* device 授权挑战 — 展示 user code, 等用户浏览器点同意后按确认 */}
      <div class="field" x-show="$store.app.xaiChallenge" x-cloak>
        <label>Enter this code on the xAI page that just opened</label>
        <div style="display:flex;gap:6px;align-items:stretch">
          <input
            type="text"
            readonly
            x-bind:value="$store.app.xaiChallenge?.userCode || ''"
            style="font-weight:700;letter-spacing:2px;text-align:center"
            title="User code for the xAI consent page"
          />
          <button
            class="secondary"
            style="flex:0 0 auto"
            x-on:click="$store.app.copyXaiCode()"
            title="Copy user code"
          >
            Copy
          </button>
        </div>
        <div class="auto-review-hint">Approve the consent screen in your browser, then press the button below.</div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button
            x-on:click="$store.app.confirmXaiLogin()"
            x-bind:disabled="$store.app.xaiWorking"
            x-text="$store.app.xaiWorking ? 'Checking…' : 'I approved — connect'"
          >
          </button>
          <button
            class="ghost"
            x-on:click="$store.app.cancelXaiLogin()"
            x-bind:disabled="$store.app.xaiWorking"
          >
            Cancel
          </button>
        </div>
      </div>
      <div class="auto-review-hint" x-show="$store.app.state">
        SuperGrok OAuth (same login as opencode). Needs an xAI provider (baseUrl https://api.x.ai/v1) to run Grok models; a static API key still works without login.
      </div>
    </>
  )
}
