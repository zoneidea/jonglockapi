function ok(res, data = null, message = '') {
  return res.json({ status: 'success', message, data });
}

function created(res, data = null, message = 'created') {
  return res.status(201).json({ status: 'success', message, data });
}

module.exports = {
  ok,
  created,
};
