'use strict'

/**
 * Profile Manager — Chrome-like user profiles for SEOZ Browser
 *
 * Each profile gets its own electron-store namespace, isolating:
 *   - API key (SEOZ)
 *   - Anthropic key
 *   - Bookmarks & bookmark folders
 *   - Browsing history
 *   - Active client selection
 *   - Theme preference
 *   - Content blocker settings
 *
 * A root store keeps the profile registry + active profile ID.
 */

const Store = require('electron-store')
const crypto = require('crypto')

// Root store — just the profile list & active profile pointer
const rootStore = new Store({
  name: 'seoz-profiles',
  defaults: {
    profiles: [],       // [{ id, name, email, avatar, color, createdAt }]
    activeProfileId: null,
    migrated: false,     // true once legacy single-user data has been migrated
  }
})

// Cache of per-profile stores (keyed by profile ID)
const profileStores = new Map()

// ── Helpers ───────────────────────────────────────────────────────────────

function generateId() {
  return crypto.randomBytes(8).toString('hex')
}

const AVATAR_COLORS = [
  '#4680ff', '#2ca87f', '#e58a00', '#dc2626', '#7c3aed',
  '#0891b2', '#be185d', '#059669', '#d97706', '#6366f1',
]

function pickColor(index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length]
}

function getInitials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return parts[0].substring(0, 2).toUpperCase()
}

// ── Per-profile store ─────────────────────────────────────────────────────

function getProfileStore(profileId) {
  if (!profileId) return null
  if (profileStores.has(profileId)) return profileStores.get(profileId)

  const ps = new Store({
    name: `profile-${profileId}`,
    defaults: {
      apiKey: null,
      anthropicKey: null,
      theme: 'light',
      autoSync: true,
      osNotifs: true,
      bookmarks: [],
      bookmarkFolders: [],
      history: [],
      activeClientId: null,
      blockerEnabled: true,
      mailAccounts: [],
      mailActiveAccountId: null,
    }
  })
  profileStores.set(profileId, ps)
  return ps
}

// ── Migration: move legacy single-store data into first profile ───────────

function migrateLegacyData(legacyStore) {
  if (rootStore.get('migrated')) return

  const existingProfiles = rootStore.get('profiles', [])
  if (existingProfiles.length > 0) {
    rootStore.set('migrated', true)
    return
  }

  // Check if there's any legacy data worth migrating
  const legacyApiKey = legacyStore.get('apiKey')
  const legacyBookmarks = legacyStore.get('bookmarks', [])
  const legacyHistory = legacyStore.get('history', [])
  const legacyTheme = legacyStore.get('theme', 'light')
  const legacyActiveClient = legacyStore.get('activeClientId')
  const legacyAnthropicKey = legacyStore.get('anthropicKey')

  if (!legacyApiKey && legacyBookmarks.length === 0) {
    // Nothing to migrate — just mark as done
    rootStore.set('migrated', true)
    return
  }

  // Create a profile from legacy data
  const profileId = generateId()
  const profile = {
    id: profileId,
    name: 'Min profil',
    email: '',
    avatar: null,
    color: pickColor(0),
    createdAt: new Date().toISOString(),
  }

  rootStore.set('profiles', [profile])
  rootStore.set('activeProfileId', profileId)

  // Copy data into profile store
  const ps = getProfileStore(profileId)
  if (legacyApiKey) ps.set('apiKey', legacyApiKey)
  if (legacyAnthropicKey) ps.set('anthropicKey', legacyAnthropicKey)
  ps.set('theme', legacyTheme)
  ps.set('bookmarks', legacyBookmarks)
  ps.set('history', legacyHistory)
  if (legacyActiveClient) ps.set('activeClientId', legacyActiveClient)

  rootStore.set('migrated', true)
  console.log('[profiles] Migrated legacy data to profile:', profile.name)
}

// ── CRUD ──────────────────────────────────────────────────────────────────

function listProfiles() {
  return rootStore.get('profiles', [])
}

function getActiveProfileId() {
  return rootStore.get('activeProfileId')
}

function getActiveProfile() {
  const id = getActiveProfileId()
  if (!id) return null
  const profiles = listProfiles()
  return profiles.find(p => p.id === id) || null
}

function createProfile({ name, email = '' }) {
  const profiles = listProfiles()
  const id = generateId()
  const profile = {
    id,
    name: name || 'Ny profil',
    email,
    avatar: null,
    color: pickColor(profiles.length),
    createdAt: new Date().toISOString(),
  }
  profiles.push(profile)
  rootStore.set('profiles', profiles)
  // Initialize profile store with defaults
  getProfileStore(id)
  return profile
}

function updateProfile(profileId, updates) {
  const profiles = listProfiles()
  const idx = profiles.findIndex(p => p.id === profileId)
  if (idx === -1) return null

  // Only allow safe fields to be updated
  const allowed = ['name', 'email', 'avatar', 'avatarUrl', 'color']
  for (const key of allowed) {
    if (updates[key] !== undefined) profiles[idx][key] = updates[key]
  }
  rootStore.set('profiles', profiles)
  return profiles[idx]
}

function deleteProfile(profileId) {
  let profiles = listProfiles()
  profiles = profiles.filter(p => p.id !== profileId)
  rootStore.set('profiles', profiles)

  // Clear profile store
  const ps = getProfileStore(profileId)
  if (ps) ps.clear()
  profileStores.delete(profileId)

  // If we deleted the active profile, switch to first remaining (or null)
  if (getActiveProfileId() === profileId) {
    rootStore.set('activeProfileId', profiles.length > 0 ? profiles[0].id : null)
  }

  return { ok: true, remaining: profiles.length }
}

function switchProfile(profileId) {
  const profiles = listProfiles()
  const exists = profiles.find(p => p.id === profileId)
  if (!exists) return null
  rootStore.set('activeProfileId', profileId)
  return exists
}

// ── Profile-scoped store access ───────────────────────────────────────────

function profileGet(key, defaultVal) {
  const ps = getProfileStore(getActiveProfileId())
  if (!ps) return defaultVal
  return ps.get(key, defaultVal)
}

function profileSet(key, value) {
  const ps = getProfileStore(getActiveProfileId())
  if (!ps) return false
  ps.set(key, value)
  return true
}

function profileDelete(key) {
  const ps = getProfileStore(getActiveProfileId())
  if (!ps) return false
  ps.delete(key)
  return true
}

// ── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  rootStore,
  migrateLegacyData,
  listProfiles,
  getActiveProfileId,
  getActiveProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  switchProfile,
  getProfileStore,
  profileGet,
  profileSet,
  profileDelete,
  getInitials,
}
