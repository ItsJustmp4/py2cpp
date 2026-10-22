counter = 0

def bump():
    global counter
    counter += 1

def is_even(n):
    if n == 0:
        return True
    return is_odd(n - 1)

def is_odd(n):
    if n == 0:
        return False
    return is_even(n - 1)

def noop():
    pass

for i in range(3):
    bump()
    last = i * 2
print(counter, last)
values = [4, 7, 1]
best = values[0]
for v in values:
    if v > best:
        best = v
        where = "found"
print(best, where)
print(is_even(10), is_odd(7))
noop()
text = 'He said "hi"\tand left\\'  # кавычки и экранирование
print(text)
total = (1 +
         2 +
         3)
print(total)
items = [
    "a",
    "b",
]
print(len(items), items)
x = 10
if x > 5: print("big")
while x > 0:
    x -= 3
print(x)
