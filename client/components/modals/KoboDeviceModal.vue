<template>
  <modals-modal ref="modal" v-model="show" name="kobo-device" :width="800" :height="'unset'" :processing="processing" :persistent="view === 'setup'">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-3xl text-white truncate">{{ title }}</p>
      </div>
    </template>

    <div v-if="view === 'setup'" class="w-full text-sm rounded-lg bg-bg shadow-lg border border-black-300 overflow-y-auto overflow-x-hidden" style="max-height: 80vh">
      <div class="w-full px-3 py-5 md:p-12">
        <p class="text-base text-white mb-4">{{ $strings.MessageKoboSetupLineOnce }}</p>

        <ui-text-input-with-label :value="setupLine" readonly show-copy :label="$strings.LabelKoboSetupLine" />

        <div v-if="isLocalhostEndpoint" class="flex items-start mt-4 p-3 rounded-md bg-warning/20 border border-warning/50">
          <span class="material-symbols text-warning text-xl pr-2">warning</span>
          <p class="text-sm text-gray-100">{{ $strings.MessageKoboLocalhostWarning }}</p>
        </div>

        <ol class="list-decimal pl-6 mt-6 space-y-1 text-gray-200">
          <li>{{ $strings.MessageKoboSetupStep1 }}</li>
          <li>{{ $strings.MessageKoboSetupStep2 }}</li>
          <li>{{ $strings.MessageKoboSetupStep3 }}</li>
          <li>{{ $strings.MessageKoboSetupStep4 }}</li>
        </ol>

        <div class="flex justify-end pt-6">
          <ui-btn color="bg-primary" @click="show = false">{{ $strings.ButtonClose }}</ui-btn>
        </div>
      </div>
    </div>

    <form v-else @submit.prevent="submitForm">
      <div class="w-full text-sm rounded-lg bg-bg shadow-lg border border-black-300">
        <div class="w-full px-3 py-5 md:p-12">
          <div class="mb-4">
            <ui-text-input-with-label ref="nameInput" v-model="newDevice.name" :disabled="processing" :label="$strings.LabelName" :placeholder="$strings.PlaceholderKoboDeviceName" />
          </div>

          <div class="mb-4">
            <ui-multi-select-dropdown v-model="newDevice.libraryIds" :items="libraryOptions" :label="$strings.LabelKoboLibrariesToSync" @input="libraryIdsChanged" />
            <p class="px-1 pt-1 text-xs text-gray-300">{{ $strings.LabelKoboLibrariesToSyncHelp }}</p>
          </div>

          <div class="flex items-center py-2">
            <ui-toggle-switch v-model="newDevice.onlyCollections" :label="$strings.LabelKoboOnlyCollections" :disabled="processing" @input="onlyCollectionsToggled" />
            <p aria-hidden="true" class="pl-4">{{ $strings.LabelKoboOnlyCollections }}</p>
          </div>

          <div v-if="newDevice.onlyCollections" class="mt-2 relative">
            <ui-multi-select-dropdown v-model="newDevice.collectionIds" :items="collectionOptions" :label="$strings.LabelKoboCollectionsToSync" />
            <p v-if="!loadingCollections && !collectionOptions.length" class="px-1 pt-1 text-xs text-gray-300">{{ $strings.MessageNoCollections }}</p>
          </div>

          <div class="flex items-center pt-6">
            <div class="grow" />
            <ui-btn color="bg-success" type="submit" :loading="processing">{{ device ? $strings.ButtonSave : $strings.ButtonAddDevice }}</ui-btn>
          </div>
        </div>
      </div>
    </form>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean,
    // Existing device to edit, null to add a new one
    device: {
      type: Object,
      default: () => null
    },
    // When set, the modal opens straight to the setup line (e.g. after regenerating the token)
    apiEndpoint: {
      type: String,
      default: null
    }
  },
  data() {
    return {
      processing: false,
      view: 'form',
      createdApiEndpoint: null,
      loadingCollections: false,
      collectionsByLibrary: {},
      newDevice: {
        name: '',
        libraryIds: [],
        onlyCollections: false,
        collectionIds: []
      }
    }
  },
  watch: {
    show: {
      handler(newVal) {
        if (newVal) {
          this.init()
        }
      }
    }
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(val) {
        this.$emit('input', val)
      }
    },
    title() {
      if (this.view === 'setup') return this.$strings.HeaderKoboSetup
      return this.device ? this.$strings.HeaderKoboEditDevice : this.$strings.HeaderKoboAddDevice
    },
    bookLibraries() {
      // Libraries in the store are the ones this user can access; Kobo only syncs ebooks
      return this.$store.getters['libraries/getSortedLibraries']().filter((lib) => lib.mediaType === 'book' && this.$store.getters['user/getCanAccessLibrary'](lib.id))
    },
    libraryOptions() {
      return this.bookLibraries.map((lib) => ({ text: lib.name, value: lib.id }))
    },
    librariesInScope() {
      if (!this.newDevice.libraryIds.length) return this.bookLibraries
      return this.bookLibraries.filter((lib) => this.newDevice.libraryIds.includes(lib.id))
    },
    collectionOptions() {
      const showLibraryName = this.librariesInScope.length > 1
      const options = []
      this.librariesInScope.forEach((lib) => {
        const collections = this.collectionsByLibrary[lib.id] || []
        collections.forEach((collection) => {
          options.push({
            text: showLibraryName ? `${collection.name} (${lib.name})` : collection.name,
            value: collection.id
          })
        })
      })
      return options
    },
    setupLine() {
      return this.createdApiEndpoint ? `api_endpoint=${this.createdApiEndpoint}` : ''
    },
    isLocalhostEndpoint() {
      if (!this.createdApiEndpoint) return false
      try {
        const hostname = new URL(this.createdApiEndpoint).hostname.toLowerCase()
        return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.startsWith('127.') || hostname === '0.0.0.0' || hostname === '[::1]' || hostname === '::1'
      } catch {
        return false
      }
    }
  },
  methods: {
    getErrorMessage(error, fallback) {
      if (error.response?.data && typeof error.response.data === 'string') {
        return error.response.data
      }
      return fallback
    },
    libraryIdsChanged() {
      this.loadCollections()
    },
    onlyCollectionsToggled(val) {
      if (val) this.loadCollections()
    },
    async loadCollections() {
      const toLoad = this.librariesInScope.filter((lib) => !this.collectionsByLibrary[lib.id])
      if (toLoad.length) {
        this.loadingCollections = true
        await Promise.all(
          toLoad.map((lib) =>
            this.$axios
              .$get(`/api/libraries/${lib.id}/collections?minified=1`)
              .then((data) => {
                this.$set(
                  this.collectionsByLibrary,
                  lib.id,
                  (data.results || []).map((c) => ({ id: c.id, name: c.name }))
                )
              })
              .catch((error) => {
                console.error('Failed to load collections for library', lib.id, error)
              })
          )
        )
        this.loadingCollections = false
      }
      this.pruneCollectionIds()
    },
    pruneCollectionIds() {
      // Drop selected collections that belong to libraries no longer selected
      // Skip if any library's collections failed to load, so nothing is dropped by mistake
      if (this.loadingCollections || this.librariesInScope.some((lib) => !this.collectionsByLibrary[lib.id])) return
      const available = new Set(this.collectionOptions.map((c) => c.value))
      this.newDevice.collectionIds = this.newDevice.collectionIds.filter((id) => available.has(id))
    },
    submitForm() {
      if (this.$refs.nameInput) this.$refs.nameInput.blur()

      const name = (this.newDevice.name || '').trim()
      if (!name) {
        this.$toast.error(this.$strings.ToastNameRequired)
        return
      }
      if (this.newDevice.onlyCollections && !this.newDevice.collectionIds.length) {
        this.$toast.error(this.$strings.ToastKoboSelectCollection)
        return
      }

      const payload = {
        name,
        libraryIds: this.newDevice.libraryIds.length ? [...this.newDevice.libraryIds] : null,
        onlyCollections: !!this.newDevice.onlyCollections,
        collectionIds: this.newDevice.onlyCollections ? [...this.newDevice.collectionIds] : []
      }

      if (this.device) {
        this.submitUpdate(payload)
      } else {
        this.submitCreate(payload)
      }
    },
    submitUpdate(payload) {
      this.processing = true
      this.$axios
        .$patch(`/api/me/kobo-devices/${this.device.id}`, payload)
        .then((data) => {
          this.$emit('update', data.device)
          this.$toast.success(this.$strings.ToastKoboDeviceUpdated)
          this.show = false
        })
        .catch((error) => {
          console.error('Failed to update Kobo device', error)
          this.$toast.error(this.getErrorMessage(error, this.$strings.ToastFailedToUpdate))
        })
        .finally(() => {
          this.processing = false
        })
    },
    submitCreate(payload) {
      this.processing = true
      this.$axios
        .$post('/api/me/kobo-devices', payload)
        .then((data) => {
          this.$emit('create', data.device)
          this.createdApiEndpoint = data.apiEndpoint
          this.view = 'setup'
        })
        .catch((error) => {
          console.error('Failed to add Kobo device', error)
          this.$toast.error(this.getErrorMessage(error, this.$strings.ToastDeviceAddFailed))
        })
        .finally(() => {
          this.processing = false
        })
    },
    init() {
      this.processing = false
      this.collectionsByLibrary = {}

      if (this.apiEndpoint) {
        this.createdApiEndpoint = this.apiEndpoint
        this.view = 'setup'
        return
      }

      this.createdApiEndpoint = null
      this.view = 'form'
      if (this.device) {
        this.newDevice.name = this.device.name || ''
        // Libraries the user lost access to can't be synced anyway, so they are dropped here
        this.newDevice.libraryIds = (this.device.libraryIds || []).filter((id) => this.bookLibraries.some((lib) => lib.id === id))
        this.newDevice.onlyCollections = !!this.device.onlyCollections
        this.newDevice.collectionIds = [...(this.device.collectionIds || [])]
        if (this.newDevice.onlyCollections) this.loadCollections()
      } else {
        this.newDevice.name = ''
        this.newDevice.libraryIds = []
        this.newDevice.onlyCollections = false
        this.newDevice.collectionIds = []
      }
    }
  }
}
</script>
