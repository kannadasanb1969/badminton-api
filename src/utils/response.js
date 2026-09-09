export function successResponse(data, status = 200) {
  return Response.json({ success: true, data }, { status });
}

export function errorResponse(message, status = 500) {
  return Response.json({ success: false, message }, { status });
}
