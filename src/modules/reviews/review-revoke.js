import { prisma } from '../../lib/prisma.js'
import { invalidateUserCache } from '../../middleware/auth.js'

const DEFAULT_REASON = 'This order is no longer eligible for review credit.'

/**
 * When a shop order is cancelled, refunded, or deleted, drop pending review claims
 * and claw back approved $5 review credit tied to that order.
 */
export async function revokeReviewCreditForOrder(orderId, { reason = DEFAULT_REASON } = {}) {
  const claim = await prisma.reviewCreditClaim.findUnique({ where: { orderId } })
  if (!claim) return { changed: false }

  if (claim.status === 'REJECTED') return { changed: false }

  const hadApproved = claim.status === 'APPROVED'

  await prisma.$transaction(async (tx) => {
    if (hadApproved) {
      const user = await tx.user.findUnique({
        where: { id: claim.userId },
        select: { creditCents: true },
      })
      if (user) {
        await tx.user.update({
          where: { id: claim.userId },
          data: { creditCents: Math.max(0, user.creditCents - claim.creditCents) },
        })
      }
    }

    await tx.reviewCreditClaim.update({
      where: { id: claim.id },
      data: {
        status: 'REJECTED',
        rejectReason: reason,
        otpHash: null,
        otpExpiresAt: null,
        otpAttempts: 0,
      },
    })
  })

  invalidateUserCache(claim.userId)
  return { changed: true, hadApproved, userId: claim.userId }
}
