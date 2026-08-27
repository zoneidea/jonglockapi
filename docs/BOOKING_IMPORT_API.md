# Booking Import API Contract

## Endpoint

`POST /management/markets/:marketId/bookings/import`

Authentication: management Bearer token with `supervisor` or `admin` role and access to the selected market.

Content type: `multipart/form-data`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | XLSX/CSV | yes | Maximum 2 MB and 500 data rows. The first worksheet row is treated as the header and is not imported. |
| `action` | `preview` or `confirm` | no | Defaults to `preview`. Preview never writes products or bookings. |
| `createMissingProducts` | boolean | confirm only | When true, missing products are created in the booth category before the booking is created. |
| `productCategories` | JSON object | confirm only | Category selections for missing products whose booths have no category, keyed as `<lowercase product name>::unassigned`. |

## Expected columns

`customer_identifier`, `booking_date`, `booth_code`, `product_name`, `note`

## Preview response

```json
{
  "mode": "preview",
  "totalRows": 1,
  "readyCount": 0,
  "missingProductCount": 1,
  "errorCount": 0,
  "availableCategories": [
    { "id": 9, "name": "อาหาร" },
    { "id": 10, "name": "ไม่ใช่อาหาร" }
  ],
  "missingProducts": [
    {
      "name": "ข้าวกล่อง",
      "categoryId": 5,
      "categoryName": "อาหาร",
      "rowNumbers": [2]
    }
  ],
  "rows": [
    {
      "rowNumber": 2,
      "customerIdentifier": "MB000001",
      "bookingDate": "2026-09-01",
      "boothCode": "B001",
      "productName": "ข้าวกล่อง",
      "note": "",
      "status": "missing_product",
      "message": "Product ข้าวกล่อง not found"
    }
  ]
}
```

Row statuses are `ready`, `missing_product`, and `error`.

## Confirm behavior

- The frontend must preview the file and obtain explicit user confirmation before sending `action=confirm`.
- If missing products exist, the frontend asks whether they should be created. Cancellation performs no write.
- If a booth has no category, the frontend asks the user to select one of `availableCategories` and sends the choice in `productCategories`.
- With `createMissingProducts=true`, each missing product is inserted or reactivated in the category assigned to its booth before the booking is created.
- Product creation and booking creation run in the same database transaction per customer group. A booking failure rolls back the products created for that group.
- Confirm response rows use `imported` or `error` and preserve every Excel column for display.

## Frontend flow

1. Upload file with `action=preview`.
2. Render `rows` using the same columns as the workbook.
3. Disable confirmation while any row has `status=error`.
4. Ask to create products when `missingProductCount > 0`.
5. Re-submit the same file with `action=confirm` and the user's `createMissingProducts` decision.
