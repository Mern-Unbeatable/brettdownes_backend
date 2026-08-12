import { env } from './env.js'
import { formatMoney } from './money.js'

const BRAND = {
  navy: '#050b14',
  cyan: '#00f5d4',
  ink: '#111827',
  muted: '#6b7280',
  fog: '#f3f4f6',
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:${BRAND.fog};font-family:'Outfit',Helvetica,Arial,sans-serif;color:${BRAND.ink};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;">
      <tr>
        <td style="background:${BRAND.navy};padding:24px 28px;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.01em;">Peptide Ops Logistics</p>
          <p style="margin:4px 0 0;color:${BRAND.cyan};font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;">${title}</p>
        </td>
      </tr>
      <tr><td style="padding:28px;">${bodyHtml}</td></tr>
      <tr>
        <td style="padding:20px 28px;background:${BRAND.fog};color:${BRAND.muted};font-size:11px;line-height:1.6;">
          For Research Use Only; Not for Human Consumption.<br />
          4472 River Rd N, PMB #1020, Keizer, OR 97303
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;margin-top:20px;padding:12px 22px;background:${BRAND.cyan};color:${BRAND.navy};border-radius:12px;font-weight:700;font-size:14px;text-decoration:none;">${label}</a>`
}

function paragraph(text) {
  return `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:${BRAND.ink};">${text}</p>`
}

function itemsTable(items) {
  const rows = items
    .map(
      (item) => `<tr>
        <td style="padding:8px 0;font-size:13px;color:${BRAND.ink};">${item.productName} <span style="color:${BRAND.muted};">(${item.dose}) x ${item.qty}</span></td>
        <td style="padding:8px 0;font-size:13px;text-align:right;color:${BRAND.ink};">${formatMoney(item.unitPriceCents * item.qty)}</td>
      </tr>`,
    )
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-top:1px solid #e5e7eb;">${rows}</table>`
}

function totals(order) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;padding-top:8px;">
    <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">Subtotal</td><td style="padding:6px 0;font-size:13px;text-align:right;">${formatMoney(order.subtotalCents)}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">${order.fulfillment === 'PICKUP' ? 'Pickup' : 'Shipping'}</td><td style="padding:6px 0;font-size:13px;text-align:right;">${order.fulfillment === 'PICKUP' ? 'Free' : formatMoney(order.shippingCents)}</td></tr>
    <tr><td style="padding:6px 0;font-size:15px;font-weight:700;">Total</td><td style="padding:6px 0;font-size:15px;font-weight:700;text-align:right;">${formatMoney(order.totalCents)}</td></tr>
  </table>`
}

export const templates = {
  registrationPending: (user) => ({
    subject: 'Your Peptide Ops registration is under review',
    html: layout(
      'Registration received',
      paragraph(`Hi ${user.name},`) +
        paragraph(
          'Thanks for registering. Our team reviews every research account manually, usually within one business day. You will receive an email the moment your access is approved.',
        ),
    ),
  }),

  registrationApproved: (user) => ({
    subject: 'Your Peptide Ops account is approved',
    html: layout(
      'Access approved',
      paragraph(`Hi ${user.name},`) +
        paragraph('Your research account has been approved. You can now sign in and browse the full catalogue.') +
        button(env.clientUrl, 'Sign in to the portal'),
    ),
  }),

  adminNewRegistration: (user) => ({
    subject: `New registration: ${user.email}`,
    html: layout(
      'New registration',
      paragraph(`<strong>${user.name}</strong> (${user.email}) requested portal access.`) +
        paragraph(
          `Company: ${user.company || '-'}<br />Phone: ${user.phone || '-'}<br />Framework: ${user.researchFramework || '-'}`,
        ) +
        button(`${env.clientUrl}/admin/customers`, 'Review in admin'),
    ),
  }),

  passwordReset: (user, resetUrl) => ({
    subject: 'Reset your Peptide Ops password',
    html: layout(
      'Password reset',
      paragraph(`Hi ${user.name},`) +
        paragraph('Use the button below to choose a new password. This link expires in 30 minutes.') +
        button(resetUrl, 'Reset password') +
        paragraph(
          `<span style="color:${BRAND.muted};font-size:12px;">If you did not request this, you can safely ignore this email.</span>`,
        ),
    ),
  }),

  orderConfirmation: (order) => ({
    subject: `Order ${order.orderNumber} confirmed`,
    html: layout(
      `Order ${order.orderNumber}`,
      paragraph(`Hi ${order.contactName},`) +
        paragraph(
          order.fulfillment === 'PICKUP'
            ? 'We received your order. Payment is due at pickup — bring this confirmation with you.'
            : 'We received your order and payment. You will get a tracking number as soon as your label is created.',
        ) +
        itemsTable(order.items) +
        totals(order) +
        button(`${env.clientUrl}/dashboard/orders`, 'View your orders'),
    ),
  }),

  adminNewOrder: (order) => ({
    subject: `New order ${order.orderNumber} - ${formatMoney(order.totalCents)}`,
    html: layout(
      'New order',
      paragraph(
        `<strong>${order.contactName}</strong> (${order.contactEmail}) placed order ${order.orderNumber}.`,
      ) +
        paragraph(
          `Method: ${order.paymentMethod === 'PICKUP' ? 'Warehouse pickup (manual)' : 'Stripe'}<br />Payment: ${order.paymentStatus}`,
        ) +
        itemsTable(order.items) +
        totals(order) +
        button(`${env.clientUrl}/admin/orders/${order.id}`, 'Open in admin'),
    ),
  }),

  orderShipped: (order) => ({
    subject: `Order ${order.orderNumber} has shipped`,
    html: layout(
      'On its way',
      paragraph(`Hi ${order.contactName},`) +
        paragraph(
          `Your order is on its way via <strong>${order.carrier || 'carrier'} ${order.service || ''}</strong>.`,
        ) +
        (order.trackingCode
          ? paragraph(`Tracking number: <strong>${order.trackingCode}</strong>`)
          : '') +
        (order.trackingUrl ? button(order.trackingUrl, 'Track your shipment') : ''),
    ),
  }),

  orderStatusChanged: (order) => ({
    subject: `Order ${order.orderNumber} is now ${order.status.toLowerCase()}`,
    html: layout(
      'Order update',
      paragraph(`Hi ${order.contactName},`) +
        paragraph(`Your order <strong>${order.orderNumber}</strong> is now marked as <strong>${order.status.toLowerCase()}</strong>.`) +
        button(`${env.clientUrl}/dashboard/orders`, 'View your orders'),
    ),
  }),
}
