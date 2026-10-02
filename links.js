// Outbound links for items and places. Mirrors app/affiliate.py.
// Affiliate IDs come from Settings (stored on this phone); without them the
// links still work, they just don't earn a commission.

const q = encodeURIComponent;

export function makeLinks(ids = {}) {
  const amazon = (s) => `https://www.amazon.com/s?k=${q(s)}` + (ids.amazon ? `&tag=${q(ids.amazon)}` : "");
  const ebay = (s) => `https://www.ebay.com/sch/i.html?_nkw=${q(s)}` + (ids.ebay
    ? `&mkcid=1&mkrid=711-53200-19255-0&siteid=0&campid=${q(ids.ebay)}&toolid=10001&mkevt=1` : "");
  // Etsy affiliate links are wrapped by Awin; add that wrapper once approved.
  const etsy = (s) => `https://www.etsy.com/search?q=${q(s)}`;
  const hotels = (s) => `https://www.booking.com/searchresults.html?ss=${q(s)}` + (ids.booking ? `&aid=${q(ids.booking)}` : "");
  const cars = () => "https://www.booking.com/cars/index.html" + (ids.booking ? `?aid=${q(ids.booking)}` : "");
  const tours = (s) => `https://www.getyourguide.com/s/?q=${q(s)}` + (ids.gyg ? `&partner_id=${q(ids.gyg)}` : "");
  const maps = (s) => `https://www.google.com/maps/search/?api=1&query=${q(s)}`;

  function forItem(item, place) {
    const s = item.search_query || item.name;
    const local = !place || s.toLowerCase().includes(place.toLowerCase()) ? s : `${s} ${place}`;
    const named = item.source === "nearby"; // a specific business found by web search
    switch (item.category) {
      case "product":
        return [
          { label: "Amazon", url: amazon(s) },
          { label: "eBay", url: ebay(s) },
          { label: "Etsy", url: etsy(s) },
        ];
      case "hotel":
        return named
          ? [{ label: "Check prices", url: hotels(local) }, { label: "Map", url: maps(local) }]
          : [{ label: "Find hotels", url: hotels(place || s) }];
      case "car_rental":
        return named
          ? [{ label: "Rent a car", url: cars() }, { label: "Map", url: maps(local) }]
          : [{ label: "Rent a car", url: cars() }];
      case "experience":
        return [{ label: "Book tours", url: tours(local) }];
      default: // restaurant / place: no affiliate program, just help people find it
        return [{ label: "Map", url: maps(local) }];
    }
  }

  function forPlace(place) {
    return [
      { label: "Hotels", url: hotels(place) },
      { label: "Car rentals", url: cars() },
      { label: "Restaurants", url: maps(`restaurants near ${place}`) },
      { label: "Tours & tickets", url: tours(place) },
    ];
  }

  return { forItem, forPlace };
}
