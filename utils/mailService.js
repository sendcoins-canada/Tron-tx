/**
 * Email service for the crypto-tx-engine.
 * Uses the same SMTP config as the sendcoins backend (ZeptoMail).
 */
const nodemailer = require('nodemailer');
const logger = require('./logger');

const transporter = nodemailer.createTransport({
  host: 'smtp.zeptomail.com',
  port: 587,
  auth: {
    user: 'emailapikey',
    pass: 'wSsVR60j8kXwDqt5mGGrdbhqn14HUlv0FEt/2QOo6napF/2X9cc/kk2YB1X1TvBKFmVvQTJDrL0ryh4E0DYI3Y8rmwkDACiF9mqRe1U4J3x17qnvhDzKVmRalReOL4kMxQ1okmVhF8kn+g==',
  },
});

/**
 * Send crypto transfer completed email.
 */
async function sendCryptoTransferEmail({ email, firstName, amount, asset, network, recipientAddress, txid, explorerUrl, fee, reference }) {
  const maskedAddr = recipientAddress.length > 10
    ? `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`
    : recipientAddress;
  const txidShort = txid ? (txid.length > 16 ? `${txid.slice(0, 8)}...${txid.slice(-8)}` : txid) : 'N/A';

  const mailOptions = {
    from: '"Sendcoins" <noreply@sendcoins.ca>',
    to: email,
    subject: `Transfer Completed: ${amount} ${asset} Sent`,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Transfer Completed</title></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f9fafb" style="padding:16px 0;">
    <tr><td align="center">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" bgcolor="#ffffff" style="max-width:600px;width:100%;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:24px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <img src="https://sendcoins.ca/images/sendcoins-logo-removebg.png" alt="Sendcoins" width="70" height="70" style="display:block;">
        </td></tr>
        <tr><td style="font-size:24px;font-weight:bold;color:#000000;padding-bottom:16px;">Crypto Transfer Completed</td></tr>
        <tr><td style="color:#6b7280;font-size:14px;line-height:1.6;padding-bottom:24px;">
          Hi${firstName ? ' ' + firstName : ''},<br><br>Your crypto transfer has been completed successfully.
        </td></tr>
        <tr><td style="background:#f0f4f8;border-radius:10px;padding:20px;">
          <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Amount Sent:</td>
              <td align="right" style="color:#333;font-size:16px;font-weight:bold;padding:8px 0;border-bottom:1px solid #e0e0e0;">${amount} ${asset}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Network:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${network.toUpperCase()}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Recipient:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${maskedAddr}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Platform Fee:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${fee} ${asset}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Transaction Hash:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${txidShort}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;">Reference:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;">${reference}</td>
            </tr>
          </table>
        </td></tr>
        ${explorerUrl ? `<tr><td align="center" style="padding:20px 0;">
          <a href="${explorerUrl}" target="_blank" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">View on Explorer</a>
        </td></tr>` : ''}
        <tr><td style="background:#d1fae5;border-left:4px solid #10b981;border-radius:4px;padding:16px;">
          <p style="margin:0;color:#065f46;font-size:14px;line-height:1.6;">
            <strong>Transfer Complete</strong><br>Your ${amount} ${asset} has been sent to ${maskedAddr} on the ${network.toUpperCase()} network.
          </p>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">&copy; 2026 Sendcoins. All rights reserved.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`[EMAIL] Transfer email sent to ${email}`);
  } catch (err) {
    logger.error(`[EMAIL] Failed to send email: ${err.message}`);
  }
}

/**
 * Send BTC transfer initiated email (pending confirmation on blockchain).
 */
async function sendBtcTransferInitiatedEmail({ email, firstName, amount, recipientAddress, txid, explorerUrl, fee, reference }) {
  const maskedAddr = recipientAddress.length > 10
    ? `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`
    : recipientAddress;
  const txidShort = txid ? (txid.length > 16 ? `${txid.slice(0, 8)}...${txid.slice(-8)}` : txid) : 'N/A';

  const mailOptions = {
    from: '"Sendcoins" <noreply@sendcoins.ca>',
    to: email,
    subject: `Transfer Initiated: ${amount} BTC Sent`,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Transfer Initiated</title></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f9fafb" style="padding:16px 0;">
    <tr><td align="center">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" bgcolor="#ffffff" style="max-width:600px;width:100%;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:24px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <img src="https://sendcoins.ca/images/sendcoins-logo-removebg.png" alt="Sendcoins" width="70" height="70" style="display:block;">
        </td></tr>
        <tr><td style="font-size:24px;font-weight:bold;color:#000000;padding-bottom:16px;">BTC Transfer Initiated</td></tr>
        <tr><td style="color:#6b7280;font-size:14px;line-height:1.6;padding-bottom:24px;">
          Hi${firstName ? ' ' + firstName : ''},<br><br>Your BTC transfer has been broadcast to the Bitcoin network and is awaiting confirmation.
        </td></tr>
        <tr><td style="background:#f0f4f8;border-radius:10px;padding:20px;">
          <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Amount Sent:</td>
              <td align="right" style="color:#333;font-size:16px;font-weight:bold;padding:8px 0;border-bottom:1px solid #e0e0e0;">${amount} BTC</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Network:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">Bitcoin (BTC)</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Recipient:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${maskedAddr}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Platform Fee:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${fee} BTC</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #e0e0e0;">Transaction Hash:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #e0e0e0;">${txidShort}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;">Reference:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;">${reference}</td>
            </tr>
          </table>
        </td></tr>
        ${explorerUrl ? `<tr><td align="center" style="padding:20px 0;">
          <a href="${explorerUrl}" target="_blank" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Track on Explorer</a>
        </td></tr>` : ''}
        <tr><td style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;padding:16px;">
          <p style="margin:0;color:#92400e;font-size:14px;line-height:1.6;">
            <strong>Awaiting Confirmation</strong><br>Your ${amount} BTC transfer to ${maskedAddr} has been broadcast. BTC transactions typically take <strong>10 to 30 minutes</strong> to confirm on the blockchain. You will be notified once the transaction is fully confirmed.
          </p>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">&copy; 2026 Sendcoins. All rights reserved.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`[EMAIL] BTC initiated email sent to ${email}`);
  } catch (err) {
    logger.error(`[EMAIL] Failed to send BTC initiated email: ${err.message}`);
  }
}

/**
 * Send admin alert when master wallet has insufficient balance for a send.
 */
async function sendAdminInsufficientBalanceEmail({ adminEmails, coin, network, amount, masterBalance, reference, userEmail }) {
  if (!adminEmails || adminEmails.length === 0) {
    logger.warn(`[EMAIL] No admin emails to notify about insufficient balance`);
    return;
  }

  const shortfall = (amount - masterBalance).toFixed(8);

  const mailOptions = {
    from: '"Sendcoins Alerts" <noreply@sendcoins.ca>',
    to: adminEmails.join(','),
    subject: `URGENT: Master Wallet Insufficient — ${coin} on ${network.toUpperCase()}`,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Master Wallet Alert</title></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f9fafb" style="padding:16px 0;">
    <tr><td align="center">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" bgcolor="#ffffff" style="max-width:600px;width:100%;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:24px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <img src="https://sendcoins.ca/images/sendcoins-logo-removebg.png" alt="Sendcoins" width="70" height="70" style="display:block;">
        </td></tr>
        <tr><td style="font-size:24px;font-weight:bold;color:#dc2626;padding-bottom:16px;">Master Wallet Insufficient</td></tr>
        <tr><td style="color:#6b7280;font-size:14px;line-height:1.6;padding-bottom:24px;">
          A crypto transfer is pending because the master wallet does not have enough ${coin} to fulfill it. The user's balance has been locked and the transfer is on hold until the master wallet is funded.
        </td></tr>
        <tr><td style="background:#fef2f2;border-radius:10px;padding:20px;">
          <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #fecaca;">Amount Needed:</td>
              <td align="right" style="color:#dc2626;font-size:16px;font-weight:bold;padding:8px 0;border-bottom:1px solid #fecaca;">${amount} ${coin}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #fecaca;">Master Balance:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #fecaca;">${masterBalance} ${coin}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #fecaca;">Shortfall:</td>
              <td align="right" style="color:#dc2626;font-size:14px;font-weight:bold;padding:8px 0;border-bottom:1px solid #fecaca;">${shortfall} ${coin}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #fecaca;">Network:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #fecaca;">${network.toUpperCase()}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;border-bottom:1px solid #fecaca;">User:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;border-bottom:1px solid #fecaca;">${userEmail}</td>
            </tr>
            <tr>
              <td style="color:#666;font-size:14px;padding:8px 0;">Reference:</td>
              <td align="right" style="color:#333;font-size:14px;font-weight:500;padding:8px 0;">${reference}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:4px;padding:16px;margin-top:16px;">
          <p style="margin:0;color:#991b1b;font-size:14px;line-height:1.6;">
            <strong>Action Required</strong><br>Please fund the master wallet with at least ${shortfall} ${coin} on the ${network.toUpperCase()} network, then resolve this transfer from the admin dashboard.
          </p>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">&copy; 2026 Sendcoins. All rights reserved.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`[EMAIL] Insufficient balance alert sent to ${adminEmails.length} admin(s)`);
  } catch (err) {
    logger.error(`[EMAIL] Failed to send admin alert: ${err.message}`);
  }
}

module.exports = { sendCryptoTransferEmail, sendBtcTransferInitiatedEmail, sendAdminInsufficientBalanceEmail };
