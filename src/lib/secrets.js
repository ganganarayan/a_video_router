import { config } from '../config.js';
import { encryptWithKey, decryptWithKey } from './crypto.js';

export const encrypt = (plaintext) => encryptWithKey(config.encryptionKey, plaintext);
export const decrypt = (stored) => decryptWithKey(config.encryptionKey, stored);
