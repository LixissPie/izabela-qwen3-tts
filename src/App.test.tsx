import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App.tsx'

describe('App', () => {
  test('renders', async () => {
    render(<App />)
    expect(await screen.findByText('TTS API URL')).toBeDefined()
  })
})
