# Order flows

## Expiry

When a pickup reservation expires, `OrderService.cancelOrder` is invoked
through the expiry worker, and `NotificationService.send_expiring` notifies
the customer.

## Cancellation

Cancellations set the order state to `cancelled` and send a notification.
