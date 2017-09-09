import RingCentral from 'ringcentral-ts';
import ExtensionInfo from 'ringcentral-ts/definitions/ExtensionInfo';
import PhoneNumberInfo from 'ringcentral-ts/definitions/PhoneNumberInfo';

import redis from './redis';
import Glip, { GlipMessage } from './Glip';
import config from './config';
import RedisTokenStore from './RedisTokenStore';

let glip: Glip;
let rcClients: { [glipUserId: string]: RingCentral } = {};
let rcExtensions: { [glipUserId: string]: ExtensionInfo } = {};
let rcExtensionNumbers: { [glipUserId: string]: ExtensionInfo[] } = {};
let rcPhoneNumbers: { [glipUserId: string]: PhoneNumberInfo[] } = {};

export function setup(g: Glip) {
	glip = g;
}
/**
 * Show logged in RingCentral accout if logged in, else show login url.
 * @param glip
 * @param msg
 * @param aiResult
 */
export async function rcLogin(g: Glip, msg: GlipMessage, aiResult) {
	glip = g;

	let rc = getRc(msg.creatorId);
	try {
		await rc.getToken();
		await showLoggedInRc(glip, msg.groupId, msg.creatorId);
	} catch (e) {
		glip.sendMessage(msg.groupId, `Please log into RingCentral at \
		[here](${rc.oauthUrl(config.RcApp.redirectUri, { state: msg.creatorId + ':' + msg.groupId, force: true })})`);
	}
}

export async function rcLogout(g: Glip, msg: GlipMessage, aiResult) {
	let rc = rcClients[msg.creatorId];
	if (!rc || !rc.getToken()) {
		g.sendMessage(msg.groupId, 'You did login.');
	} else {
		await rc.logout();
		g.sendMessage(msg.groupId, 'Logout success.');
	}
}

/**
 *
 * @param groupId
 * @param callbackUrl
 */
export async function loggedIn(query) {
	let { state, code, error_description, error } = query;
	if (!state || !state.match(/.+:.+/)) {
		throw new Error('Invalid state parameter.');
	}
	if (!code) {
		throw new Error('No auth code, ' + error + ', ' + error_description);
	}
	let parts = state.split(':');
	let glipUserId = parts[0];
	let groupId = parts[1];
	let rc = getRc(glipUserId);
	try {
		await rc.oauth(code, config.RcApp.redirectUri);
	} catch (e) {
		await glip.sendMessage(groupId, 'Login failed:' + e);
		throw e;
	}
	await showLoggedInRc(glip, groupId, glipUserId);
}

async function showLoggedInRc(glip: Glip, groupId: string, glipUserId: string) {
	let ext = await getRcExtension(glipUserId);
	glip.sendMessage(groupId, `@${glipUserId} The RingCentral account you logged in is ${ext.name}(${ext.extensionNumber}, ${ext.contact.email}).`);
}

export function getRc(creatorId: string) {
	let rc = rcClients[creatorId];
	if (!rc) {
		rc = new RingCentral(config.RcApp);
		rc.tokenStore = new RedisTokenStore('rc-token:glip-user:' + creatorId, redis);
		rcClients[creatorId] = rc;
	}
	return rc;
}

export async function getRcExtension(glipUserId: string) {
	let ext = rcExtensions[glipUserId];
	if (!ext) {
		let rc = getRc(glipUserId);
		ext = await rc.account().extension().get();
		rcExtensions[glipUserId] = ext;
	}
	return ext;
}

async function fetchPagingList(fetchPath: any, page = 1) {
	const response = await fetchPath.list({
		perPage: 100,
		page,
	});
	const paging = response.paging;
	let records = response.records;
	if (paging.totalPages > paging.page) {
		records = records.concat(await fetchPagingList(fetchPath, paging.page + 1));
	}
	return records;
}

export async function getRcExtensionList(glipUserId: string) {
	let extList = rcExtensionNumbers[glipUserId];
	if (!extList) {
		try {
			let rc = getRc(glipUserId);
			extList = await fetchPagingList(rc.account().extension());
			rcExtensionNumbers[glipUserId] = extList;
		} catch (error) {
			console.log(error);
			extList = [];
		}
	}
	return extList;
}

export async function searchContacts(glipUserId: string, userName: string) {
	let contacts = [];
	const extensionNumbers = await getRcExtensionList(glipUserId);
	contacts = extensionNumbers.filter((extension) => {
		if (extension.name === userName) {
			return true;
		}
		if (extension.contact.firstName === userName) {
			return true;
		}
		return false;
	}).map((extension) => ({
		name: extension.name,
		firstName: extension.contact.firstName,
		lastName: extension.contact.lastName,
		phoneNumber: extension.extensionNumber,
	}));
	try {
		const rc = getRc(glipUserId);
		const response = await rc.account().extension().addressBook().contact().list({
			startsWith: userName,
		});
		const searchResult = response.records.map((record) => ({
			name: `${record.firstName} ${record.lastName}`,
			firstName: record.firstName,
			lastName: record.lastName,
			phoneNumber: record.mobilePhone,
		}));
		contacts = contacts.concat(searchResult);
	} catch (error) {
		console.log(error);
	}

	return contacts;
};

export async function getPhoneNumbers(glipUserId: string) {
	let phoneNumbers = rcPhoneNumbers[glipUserId];
	if (!phoneNumbers) {
		try {
			let rc = getRc(glipUserId);
			phoneNumbers = await fetchPagingList(rc.account().extension().phoneNumber());
			rcPhoneNumbers[glipUserId] = phoneNumbers;
		} catch (error) {
			phoneNumbers = [];
		}
	}
	return phoneNumbers;
}

export async function getSMSPhoneNumbers(glipUserId: string) {
	let phoneNumbers = await getPhoneNumbers(glipUserId);
	phoneNumbers = phoneNumbers.filter(
		p => (p.features && p.features.indexOf('SmsSender') !== -1)
	);
	return phoneNumbers;
}
