import express from 'express';
import Papa from 'papaparse';

import { ClientError } from 'lib/errors';
import { MetaData } from 'db/notifications';
import Notifications from '../lib/notifications';
import Invite from '../modules/invite';
import Subscribe from '../modules/subscribe';
import logger from '../lib/logger';

const router = express.Router();

export interface InviteeData {
    email: string;
    fName: string;
    lName: string;
}

export interface InviteManyData {
    inviteeList: Array<InviteeData>;
    MoC: string;
    topic: string;
    eventDateTime: string;
    constituentScope: string;
    region: string;
    deliveryTime?: string; // ISO format
}

router.post('/invite', (req, res, next) => {
    try {
        // Get headers and ensure they are all defined & that deliveryTime is valid
        const MoC = req.headers?.moc;
        const topic = req.headers?.topic;
        const eventDateTime = req.headers?.eventdatetime;
        const constituentScope = req.headers?.constituentscope;
        const region = req.headers?.region;
        const rawmetadata = req.headers?.metadata;
        const deliveryTimeHeader = req.headers?.deliverytime;
        if (
            MoC === undefined ||
            topic === undefined ||
            eventDateTime === undefined ||
            constituentScope === undefined ||
            region === undefined ||
            rawmetadata === undefined
        )
            throw new ClientError('Undefined Header Data');
        // Validate Delivery Time
        const deliveryTime: Date = Invite.validateDeliveryTime(
            deliveryTimeHeader
        );
        // Construct csvString from stream buffer
        let csvString = '';
        req.on('data', (data) => {
            csvString += data;
        });
        req.on('end', () => {
            async function invite() {
                try {
                    // Parse the csvString
                    const result = Papa.parse(csvString, {
                        header: true,
                    });
                    const inviteeList = result.data as Array<InviteeData>; // Validate these fields on frontend
                    const unsubSet = new Set(
                        await Notifications.getUnsubList(region as string) // Checked if undefined earlier
                    );
                    const filteredInviteeList = inviteeList.filter(
                        (item: InviteeData) => {
                            return !unsubSet.has(item.email);
                        }
                    );
                    if (filteredInviteeList.length === 0) {
                        throw new ClientError('No valid invitees');
                    }
                    const results = await Invite.inviteMany(
                        filteredInviteeList,
                        MoC as string, // Checked if undefined earlier
                        topic as string,
                        eventDateTime as string,
                        constituentScope as string,
                        deliveryTime
                    );
                    // Parse metadata
                    const metadata = JSON.parse(
                        rawmetadata as string
                    ) as MetaData;
                    metadata.sentDateTime = new Date().toUTCString();
                    await Notifications.addToInviteHistory(
                        metadata,
                        region as string
                    );
                    logger.print(JSON.stringify(results));
                    res.status(200).send();
                } catch (e) {
                    logger.err(e);
                    next(e);
                }
            }
            // eslint-disable-next-line no-void
            void invite();
        });
    } catch (e) {
        logger.err(e);
        next(e);
    }
});

export interface SubscribeData {
    email: string;
    region: string;
}

router.post('/subscribe', async (req, res, next) => {
    try {
        const data = req.body as SubscribeData;
        if (data.email === undefined || data.region === undefined) {
            throw new ClientError('Invalid Body');
        }
        const isSubscribed = await Notifications.isSubscribed(
            data.email,
            data.region
        );
        if (isSubscribed) {
            throw new ClientError('Already subscribed.');
        }
        const isUnsubscribed = await Notifications.isUnsubscribed(
            data.email,
            data.region
        );
        // By default any subscriber will be removed from the unsub list
        if (isUnsubscribed) {
            await Notifications.removeFromUnsubList(data.email, data.region);
            await Subscribe.mailgunDeleteFromUnsubList(data.email);
        }
        await Notifications.addToSubList(data.email, data.region);
        res.status(200).send();
    } catch (e) {
        logger.err(e);
        next(e);
    }
});

router.post('/unsubscribe', async (req, res, next) => {
    try {
        const data = req.body as SubscribeData;
        if (data.email === undefined || data.region === undefined) {
            throw new ClientError('Invalid Body');
        }
        const isUnsubscribed = await Notifications.isUnsubscribed(
            data.email,
            data.region
        );
        if (isUnsubscribed) {
            throw new ClientError('Already unsubscribed');
        }
        const isSubscribed = await Notifications.isSubscribed(
            data.email,
            data.region
        );
        if (isSubscribed)
            // Remove email from subscribe list
            await Notifications.removeFromSubList(data.email, data.region);
        await Notifications.addToUnsubList(data.email, data.region);
        await Subscribe.mailgunUnsubscribe(data.email);
        res.status(200).send();
    } catch (e) {
        logger.err(e);
        next(e);
    }
});

export default router;
