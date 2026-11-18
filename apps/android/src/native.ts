import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Notifications from 'expo-notifications';
import type {AuthConfig, Session} from './types';
import {APIClient, APIError, type SessionStore} from './api';

WebBrowser.maybeCompleteAuthSession();
async function key(origin: string) { return `superagent.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, origin)}`; }
export const secureSessions: SessionStore = {
  async read(origin) { const value = await SecureStore.getItemAsync(await key(origin)); if (!value) return null; try { return JSON.parse(value) as Session; } catch { await SecureStore.deleteItemAsync(await key(origin)); return null; } },
  async write(origin, session) { await SecureStore.setItemAsync(await key(origin), JSON.stringify(session)); },
  async remove(origin) { await SecureStore.deleteItemAsync(await key(origin)); }
};
export const api = new APIClient(secureSessions, () => Crypto.randomUUID());
export async function authenticateOIDC(config: AuthConfig) {
  if (!config.issuer || !config.client_id) throw new APIError(0, 'oidc_config', '服务器尚未配置 OIDC 登录服务');
  const discovery = await AuthSession.fetchDiscoveryAsync(config.issuer);
  const redirectUri = config.redirect_uri ?? AuthSession.makeRedirectUri({scheme: 'superagent', path: 'auth'});
  const request = new AuthSession.AuthRequest({clientId: config.client_id, redirectUri, scopes: ['openid', 'profile', 'email', 'offline_access'], responseType: AuthSession.ResponseType.Code, usePKCE: true});
  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success' || !result.params.code) throw new APIError(0, 'login_cancelled', '登录未完成');
  const token = await AuthSession.exchangeCodeAsync({clientId: config.client_id, code: result.params.code, redirectUri, extraParams: {code_verifier: request.codeVerifier ?? ''}}, discovery);
  return api.exchange(token.accessToken);
}
export async function registerPush(projectId: string) {
  if (!projectId) throw new APIError(0, 'push_config', '远程通知需要先配置 Expo 项目和 Android 推送凭据');
  await Notifications.setNotificationChannelAsync('assistant', {name: '助理待处理事项', importance: Notifications.AndroidImportance.HIGH});
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new APIError(0, 'push_permission', '通知权限未开启，可在系统设置中修改');
  const token = await Notifications.getExpoPushTokenAsync({projectId});
  return api.request('/clients/push-registrations', {method: 'POST', body: {provider: 'expo', token: token.data, platform: 'android'}});
}
