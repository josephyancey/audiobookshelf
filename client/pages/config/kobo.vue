<template>
  <div>
    <app-settings-content :header-text="$strings.HeaderKoboSync" :description="$strings.MessageKoboSyncDescription">
      <div class="flex items-center py-2">
        <ui-toggle-switch v-model="koboSyncEnabled" :label="$strings.LabelKoboSyncEnabled" :disabled="updatingServerSettings" @input="(val) => updateSettingsKey('koboSyncEnabled', val)" />
        <ui-tooltip :text="$strings.LabelKoboSyncEnabledHelp">
          <p class="pl-4 flex items-center">
            <span aria-hidden="true">{{ $strings.LabelKoboSyncEnabled }}</span>
            <span class="material-symbols text-lg pl-1">info</span>
          </p>
        </ui-tooltip>
      </div>

      <div class="flex items-center py-2">
        <ui-toggle-switch v-model="koboStoreProxy" :label="$strings.LabelKoboStoreProxy" :disabled="updatingServerSettings" @input="(val) => updateSettingsKey('koboStoreProxy', val)" />
        <ui-tooltip :text="$strings.LabelKoboStoreProxyHelp">
          <p class="pl-4 flex items-center">
            <span aria-hidden="true">{{ $strings.LabelKoboStoreProxy }}</span>
            <span class="material-symbols text-lg pl-1">info</span>
          </p>
        </ui-tooltip>
      </div>

      <form class="pt-4" @submit.prevent="savePublicUrl">
        <ui-text-input-with-label ref="publicUrlInput" v-model="koboPublicUrl" :disabled="updatingServerSettings" :label="$strings.LabelKoboPublicUrl" placeholder="https://audiobooks.example.com" />
        <p class="px-1 pt-1 text-xs text-gray-300">{{ $strings.LabelKoboPublicUrlHelp }}</p>

        <div class="flex items-center justify-end pt-4">
          <ui-btn v-if="publicUrlChanged" :disabled="updatingServerSettings" type="button" class="mr-2" @click="initServerSettings">{{ $strings.ButtonReset }}</ui-btn>
          <ui-btn :loading="updatingServerSettings" :disabled="!publicUrlChanged" type="submit">{{ $strings.ButtonSave }}</ui-btn>
        </div>
      </form>
    </app-settings-content>
  </div>
</template>

<script>
export default {
  asyncData({ store, redirect }) {
    if (!store.getters['user/getIsAdminOrUp']) {
      redirect('/')
    }
  },
  data() {
    return {
      updatingServerSettings: false,
      koboSyncEnabled: false,
      koboStoreProxy: true,
      koboPublicUrl: ''
    }
  },
  watch: {
    serverSettings(newVal, oldVal) {
      if (newVal && !oldVal) {
        this.initServerSettings()
      }
    }
  },
  computed: {
    serverSettings() {
      return this.$store.state.serverSettings
    },
    savedPublicUrl() {
      return this.serverSettings?.koboPublicUrl || ''
    },
    publicUrlChanged() {
      return (this.koboPublicUrl || '').trim() !== this.savedPublicUrl
    }
  },
  methods: {
    initServerSettings() {
      const settings = this.serverSettings || {}
      this.koboSyncEnabled = !!settings.koboSyncEnabled
      this.koboStoreProxy = settings.koboStoreProxy !== false
      this.koboPublicUrl = settings.koboPublicUrl || ''
    },
    savePublicUrl() {
      if (this.$refs.publicUrlInput) this.$refs.publicUrlInput.blur()

      let url = (this.koboPublicUrl || '').trim().replace(/\/+$/, '')
      if (url) {
        let parsed = null
        try {
          parsed = new URL(url)
        } catch {
          parsed = null
        }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
          this.$toast.error(this.$strings.ToastKoboPublicUrlInvalid)
          return
        }
      }
      this.updateSettingsKey('koboPublicUrl', url || null)
    },
    updateSettingsKey(key, val) {
      this.updatingServerSettings = true
      this.$store.dispatch('updateServerSettings', { [key]: val }).then((response) => {
        this.updatingServerSettings = false

        if (response.error) {
          console.error('Failed to update server settings', response.error)
          this.$toast.error(response.error)
        } else {
          this.$toast.success(this.$strings.ToastServerSettingsUpdateSuccess)
        }
        this.initServerSettings()
      })
    }
  },
  mounted() {
    this.initServerSettings()
  }
}
</script>
