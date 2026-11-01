// Prints a fresh VAPID key pair for SIPGES_VAPID_PUBLIC_KEY / SIPGES_VAPID_PRIVATE_KEY (ADR 0014).
// Store the private key as a secret; rotating it invalidates every device subscription.
import { generateVapidKeys } from '../contexts/automation/infrastructure/index.ts';

const keys = generateVapidKeys();
console.log(`SIPGES_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`SIPGES_VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('SIPGES_VAPID_SUBJECT=mailto:<contacto del administrador>');
