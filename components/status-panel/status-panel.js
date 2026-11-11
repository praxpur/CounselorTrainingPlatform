Component({
  properties: { loading: Boolean, errorMessage: String },
  methods: {
    retry() {
      this.triggerEvent('retry')
    },
  },
})
