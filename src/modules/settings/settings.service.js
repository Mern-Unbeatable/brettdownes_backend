import { prisma } from '../../lib/prisma.js'
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  resolvePickupLocations,
} from './settings.defaults.js'

const SETTINGS_CACHE_TTL_MS = 30_000
let settingsCache = null

function mergeSettings(stored = {}) {
  const pickupLocations = resolvePickupLocations({ ...DEFAULT_SETTINGS, ...stored })
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    shipFrom: { ...DEFAULT_SETTINGS.shipFrom, ...(stored.shipFrom || {}) },
    pickupLocations,
    // Keep single-address shape in sync for any older readers.
    pickupAddress: pickupLocations[0],
    defaultParcel: { ...DEFAULT_SETTINGS.defaultParcel, ...(stored.defaultParcel || {}) },
  }
}

/** Reads the settings row, merged over defaults so new keys always resolve. */
export async function getSettings() {
  if (settingsCache && settingsCache.expiresAt > Date.now()) {
    return settingsCache.value
  }

  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } })
  const stored = row?.value && typeof row.value === 'object' ? row.value : {}
  const value = mergeSettings(stored)
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS }
  return value
}

export async function updateSettings(patch) {
  const current = await getSettings()

  const pickupLocations = Array.isArray(patch.pickupLocations)
    ? resolvePickupLocations({ pickupLocations: patch.pickupLocations })
    : current.pickupLocations

  const next = {
    ...current,
    ...patch,
    shipFrom: { ...current.shipFrom, ...(patch.shipFrom || {}) },
    pickupLocations,
    pickupAddress: pickupLocations[0],
    defaultParcel: { ...current.defaultParcel, ...(patch.defaultParcel || {}) },
  }

  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: next },
    create: { key: SETTINGS_KEY, value: next },
  })

  settingsCache = { value: next, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS }
  return next
}

/** Recipients for admin notifications, falling back to the admin accounts. */
export async function getAdminRecipients(settings) {
  const configured = (settings?.adminNotifyEmails || []).filter(Boolean)
  if (configured.length) return configured

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
    select: { email: true },
  })
  return admins.map((admin) => admin.email)
}
