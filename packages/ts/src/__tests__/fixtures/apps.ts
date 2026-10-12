import { createApp } from '../../index.js'

export default createApp().get('/hello', c => c.text('Hello from a module'))
