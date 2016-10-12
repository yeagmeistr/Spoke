import { sendMessage, rentNewCell } from '../server/api/lib/nexmo'
import { twilioSendMessage, twilioRentNewCell } from '../server/api/lib/twilio'
import { getFormattedPhoneNumber } from '../lib/phone-format'
import { r, UserCell } from '../server/models'
import { log } from '../lib'
import { sleep } from './lib'

const PER_ASSIGNED_NUMBER_MESSAGE_COUNT = 300
const SERVICES = ['nexmo', 'twilio']

async function assignUserNumbers() {
  const unassignedMessages = await r.table('message')
    .getAll('QUEUED', { index: 'send_status' })
    .filter({ user_number: '' })
  for (let index = 0; index < unassignedMessages.length; index++) {
    const message = unassignedMessages[index]
    let userNumber

    // always use already used cell in a thread with a user.
    const lastMessage = await r.table('message')
      .getAll(message.assignment_id, { index: 'assignment_id' })
      .filter({ contact_number: message.contact_number })
      .filter((doc) => doc('user_number').ne(''))
      .limit(1)(0)
      .default(null)

    // Assign service
    let service = null
    if (lastMessage) {
      service = lastMessage.service
    } else {
      // service = SERVICES[Math.floor(Math.random() * SERVICES.length)]
      service = 'twilio'
    }

    const assignment = await r.table('assignment')
      .get(message.assignment_id)

    const userId = assignment.user_id

    let userCell = await r.table('user_cell')
      .getAll(userId, { index: 'user_id' })
      .filter({ is_primary: true, service })
      .limit(1)(0)
      .default(null)

    if (!userCell) {
      const newCell = service === 'nexmo' ? await rentNewCell() : await twilioRentNewCell()

      userCell = new UserCell({
        cell: getFormattedPhoneNumber(newCell),
        user_id: userId,
        is_primary: true,
        service
      })

      await userCell.save()
    }

    if (lastMessage) {
      userNumber = lastMessage.user_number
    } else {
      userNumber = userCell.cell
    }

    log.info("Assigning ", userNumber, " to message ", message.id)
    await r.table('message')
      .get(message.id)
      .update({
        user_number: userNumber,
        service
      })

    // Cycle cell when necessary
    const messageCount = await r.table('message')
      .getAll(userCell.cell, { index: 'user_number' })
      .filter({ service })
      .count()

    if (messageCount >= PER_ASSIGNED_NUMBER_MESSAGE_COUNT) {
      await r.table('user_cell')
        .get(userCell.id)
        .update({ is_primary: false })
    }
  }
}

async function sendMessages(service, sendMessageFunction) {
  const messages = await r.table('message')
    .getAll('QUEUED', { index: 'send_status' })
    .filter((doc) => doc('user_number').ne(''))
    .filter({ service })
    .group('user_number')
    .orderBy('created_at')
    .limit(1)(0)
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index].reduction
    await sendMessageFunction(message)
  }
}

(async () => {
  while (true) {
    try {
      await sleep(1100)
      await assignUserNumbers()
      await sendMessages('twilio', twilioSendMessage)
      await sendMessages('nexmo', sendMessage)
    } catch (ex) {
      console.log(ex)
      log.error(ex)
    }
  }
})()
