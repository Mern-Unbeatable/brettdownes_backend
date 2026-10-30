import { env } from './env.js'
import { formatMoney } from './money.js'

const BRAND = {
  navy: '#050b14',
  cyan: '#00f5d4',
  ink: '#111827',
  muted: '#6b7280',
  fog: '#f3f4f6',
}

function points(title, items) {
  const rows = items
    .map(
      (item) => `<tr>
        <td valign="top" width="16" style="padding:0 0 8px;font-size:16px;line-height:1.4;color:${BRAND.navy};">•</td>
        <td style="padding:0 0 8px;font-size:14px;line-height:1.5;color:${BRAND.ink};">${item}</td>
      </tr>`,
    )
    .join('')
  return `<p style="margin:4px 0 8px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.muted};">${title}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;">${rows}</table>`
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      @media only screen and (max-width: 520px) {
        .email-shell { padding: 12px !important; }
        .email-body-pad { padding: 20px 16px !important; }
        .email-header-pad { padding: 20px 16px !important; }
        .email-footer-pad { padding: 16px !important; }
      }
    </style>
  </head>
  <body class="email-shell" style="margin:0;padding:24px;background:${BRAND.fog};font-family:'Outfit',Helvetica,Arial,sans-serif;color:${BRAND.ink};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;">
      <tr>
        <td class="email-header-pad" style="background:${BRAND.navy};padding:24px 28px;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.01em;">Peptide Ops Logistics</p>
          <p style="margin:4px 0 0;color:${BRAND.cyan};font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;">${title}</p>
        </td>
      </tr>
      <tr><td class="email-body-pad" style="padding:28px;">${bodyHtml}</td></tr>
      <tr>
        <td class="email-footer-pad" style="padding:20px 28px;background:${BRAND.fog};color:${BRAND.muted};font-size:11px;line-height:1.6;">
          For Research Use Only; Not for Human Consumption.<br />
          4472 River Rd N, PMB #1020, Keizer, OR 97303
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function button(href, label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
  <tr>
    <td align="center" style="padding:0;">
      <a href="${href}" style="display:block;width:100%;max-width:100%;box-sizing:border-box;padding:14px 18px;background:${BRAND.cyan};color:${BRAND.navy};border-radius:12px;font-weight:700;font-size:14px;line-height:1.35;text-decoration:none;text-align:center;">${label}</a>
    </td>
  </tr>
</table>`
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
    ${order.discountCents > 0 ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">Bulk reward${order.discountLabel ? ` (${order.discountLabel})` : ''}</td><td style="padding:6px 0;font-size:13px;text-align:right;color:#059669;">-${formatMoney(order.discountCents)}</td></tr>` : ''}
    <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">${order.fulfillment === 'PICKUP' ? 'Pickup' : 'Shipping'}</td><td style="padding:6px 0;font-size:13px;text-align:right;">${order.fulfillment === 'PICKUP' ? 'Free' : formatMoney(order.shippingCents)}</td></tr>
    <tr><td style="padding:6px 0;font-size:15px;font-weight:700;">Total</td><td style="padding:6px 0;font-size:15px;font-weight:700;text-align:right;">${formatMoney(order.totalCents)}</td></tr>
  </table>`
}

function storeItemsTable(items) {
  const rows = (items || [])
    .map((item) => {
      const specs = [item.strength, item.vialSize].filter(Boolean).join(', ')
      const label = `${item.productName}${specs ? ` <span style="color:${BRAND.muted};">(${specs})</span>` : ''} <span style="color:${BRAND.muted};">x ${item.qty}</span>`
      return `<tr>
        <td style="padding:8px 0;font-size:13px;color:${BRAND.ink};">${label}</td>
        <td style="padding:8px 0;font-size:13px;text-align:right;color:${BRAND.ink};">${formatMoney(item.unitPriceCents * item.qty)}</td>
      </tr>`
    })
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-top:1px solid #e5e7eb;">${rows}</table>`
}

function storeTotals(order) {
  const discountRow =
    order.discountCents > 0
      ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">Discount${order.couponCode ? ` (${order.couponCode})` : ''}</td><td style="padding:6px 0;font-size:13px;text-align:right;">-${formatMoney(order.discountCents)}</td></tr>`
      : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;padding-top:8px;">
    <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">Subtotal</td><td style="padding:6px 0;font-size:13px;text-align:right;">${formatMoney(order.subtotalCents)}</td></tr>
    ${discountRow}
    <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.muted};">${order.shippingLabel || 'Shipping'}</td><td style="padding:6px 0;font-size:13px;text-align:right;">${formatMoney(order.shippingCents)}</td></tr>
    <tr><td style="padding:6px 0;font-size:15px;font-weight:700;">Total</td><td style="padding:6px 0;font-size:15px;font-weight:700;text-align:right;">${formatMoney(order.totalCents)}</td></tr>
  </table>`
}

function storeAddress(order) {
  return [
    order.addressLine1,
    order.addressLine2,
    [order.city, order.state, order.zip].filter(Boolean).join(', '),
    order.country,
  ]
    .filter(Boolean)
    .join('<br />')
}

export const templates = {
  registrationOtp: (name, otp) => ({
    subject: 'Your Peptide Ops verification code',
    html: layout(
      'Email verification',
      paragraph(`Hi ${name},`) +
        paragraph('Use this one-time code to finish creating your research account. It expires in 10 minutes.') +
        `<p style="margin:20px 0;font-size:28px;font-weight:700;letter-spacing:0.28em;color:${BRAND.navy};">${otp}</p>` +
        paragraph(
          `<span style="color:${BRAND.muted};font-size:12px;">If you did not start a registration, you can ignore this email.</span>`,
        ),
    ),
  }),

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

  adminLoginCredentials: ({ name, email, password }) => ({
    subject: 'Your Peptide Ops admin login details',
    html: layout(
      'Admin access',
      paragraph(`Hi ${name || 'there'},`) +
        paragraph(
          'Your administrator account for Peptide Ops Logistics is ready. Use the credentials below to sign in to the portal.',
        ) +
        paragraph(
          `Email: <strong>${email}</strong><br />Password: <strong>${password}</strong>`,
        ) +
        button(`${env.clientUrl}/login`, 'Sign in to the portal') +
        paragraph(
          `<span style="color:${BRAND.muted};font-size:12px;">For security, change this password after your first sign-in and do not share these details.</span>`,
        ),
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
            ? order.paymentStatus === 'PAID'
              ? 'We received your order and card payment. Bring this confirmation and photo ID when you collect your order.'
              : 'We received your order. Payment is due at pickup — bring this confirmation with you.'
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

  orderStatusChanged: (order) => {
    const delivered = order.status === 'DELIVERED'
    return {
      subject: delivered
        ? `Order ${order.orderNumber} has been delivered`
        : `Order ${order.orderNumber} is now ${order.status.toLowerCase()}`,
      html: layout(
        delivered ? 'Delivered' : 'Order update',
        paragraph(`Hi ${order.contactName},`) +
          paragraph(
            delivered
              ? `Your order <strong>${order.orderNumber}</strong> has been delivered.`
              : `Your order <strong>${order.orderNumber}</strong> is now marked as <strong>${order.status.toLowerCase()}</strong>.`,
          ) +
          button(`${env.clientUrl}/dashboard/orders`, 'View your orders'),
      ),
    }
  },

  storeOrderConfirmation: (order) => ({
    subject: `Order ${order.orderNumber} confirmed`,
    html: layout(
      `Order ${order.orderNumber}`,
      paragraph(`Hi ${order.contactName},`) +
        paragraph(
          'Thanks for your order — we received your payment. You will get an email with a tracking link as soon as it ships.',
        ) +
        storeItemsTable(order.items) +
        storeTotals(order) +
        paragraph(
          `<span style="color:${BRAND.muted};font-size:12px;">Shipping to:<br />${storeAddress(order)}</span>`,
        ),
    ),
  }),

  storeAdminNewOrder: (order) => ({
    subject: `New store order ${order.orderNumber} - ${formatMoney(order.totalCents)}`,
    html: layout(
      'New store order',
      paragraph(
        `<strong>${order.contactName}</strong> (${order.contactEmail}, ${order.contactPhone}) placed order ${order.orderNumber}.`,
      ) +
        storeItemsTable(order.items) +
        storeTotals(order) +
        paragraph(
          `<span style="color:${BRAND.muted};font-size:12px;">Ship to:<br />${storeAddress(order)}</span>`,
        ) +
        button(`${env.clientUrl}/admin/store-orders`, 'Open in admin'),
    ),
  }),

  storeOrderShipped: (order) => ({
    subject: `Order ${order.orderNumber} has shipped`,
    html: layout(
      'On its way',
      paragraph(`Hi ${order.contactName},`) +
        paragraph(
          `Your order is on its way${order.carrier ? ` via <strong>${order.carrier}</strong>` : ''}.`,
        ) +
        (order.trackingCode
          ? paragraph(`Tracking number: <strong>${order.trackingCode}</strong>`)
          : '') +
        (order.trackingUrl ? button(order.trackingUrl, 'Track your shipment') : ''),
    ),
  }),

  storeOrderStatusChanged: (order) => {
    const delivered = order.status === 'DELIVERED'
    return {
      subject: delivered
        ? `Order ${order.orderNumber} has been delivered`
        : `Order ${order.orderNumber} is now ${order.status.toLowerCase()}`,
      html: layout(
        delivered ? 'Delivered' : 'Order update',
        paragraph(`Hi ${order.contactName},`) +
          paragraph(
            delivered
              ? `Your order <strong>${order.orderNumber}</strong> has been delivered.`
              : `Your order <strong>${order.orderNumber}</strong> is now marked as <strong>${order.status.toLowerCase()}</strong>.`,
          ) +
          (delivered ? button(`${env.clientUrl}/dashboard/orders`, 'View your orders') : ''),
      ),
    }
  },

  reviewOtp: ({ name, code }) => ({
    subject: 'Your Peptide Ops review credit code',
    html: layout(
      'Review credit',
      paragraph(`Hi ${name},`) +
        paragraph(
          'Use this code to confirm the email you used for your Trustpilot review. It expires in 10 minutes.',
        ) +
        paragraph(
          `<span style="display:inline-block;letter-spacing:0.35em;font-size:22px;font-weight:700;">${code}</span>`,
        ) +
        paragraph(
          `<span style="color:${BRAND.muted};font-size:12px;">If you did not request this, you can ignore this email.</span>`,
        ),
    ),
  }),

  reviewCreditAdded: ({ name, addedCents, balanceCents, orderNumber }) => ({
    subject: `${formatMoney(addedCents)} review credit added`,
    html: layout(
      'Review credit',
      paragraph(`Hi ${name},`) +
        paragraph(
          `Your Trustpilot review${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''} was approved.`,
        ) +
        points('What you get', [
          `<strong>${formatMoney(addedCents)}</strong> account credit`,
          'Use it on any product at checkout',
        ]) +
        button(`${env.clientUrl}/shop`, 'Shop products'),
    ),
  }),

  accountCredit: ({ name, addedCents, balanceCents }) => ({
    subject: `${formatMoney(addedCents)} account credit added`,
    html: layout(
      'Account credit',
      paragraph(`Hi ${name},`) +
        paragraph(
          `We added <strong>${formatMoney(addedCents)}</strong> of account credit to your Peptide Ops account.`,
        ) +
        paragraph(
          `Your available balance is now <strong>${formatMoney(balanceCents)}</strong>. Use it at checkout on products. It does not cover shipping.`,
        ) +
        button(`${env.clientUrl}/dashboard`, 'View your dashboard'),
    ),
  }),
}
